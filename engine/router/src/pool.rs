//! The engine's threads: one pool answers the requests and runs the independent searches of a request
//! (its island checks, then its sections) on the threads that are free, next to the request's own.
//!
//! A request waiting for its searches runs those of them nobody has started yet itself, so it never
//! depends on a free thread. Each thread keeps its own `Router` (profile cache and search arenas):
//! profile contexts cannot move between threads.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use brouter_mapaccess::SegmentStore;

use crate::engine::{Job, JobResult};
use crate::java::JavaException;
use crate::request::{Answer, Router};

/// How a request ended: its answer, or the panic of an internal error.
pub type Outcome = std::thread::Result<Result<Answer, JavaException>>;

type Reply = Box<dyn FnOnce(Outcome, Duration) + Send>;

/// A pool of routing threads sharing one `SegmentStore`.
pub struct RouterPool {
    pool: Pool,
    threads: Vec<JoinHandle<()>>,
}

impl RouterPool {
    /// `threads` threads, each with its own profile cache for `profile_dir`.
    pub fn new(segments: Arc<SegmentStore>, profile_dir: impl Into<PathBuf>, threads: usize) -> Self {
        let profile_dir = profile_dir.into();
        let pool = Pool(Arc::new(Shared { queue: Mutex::default(), work: Condvar::new(), threads: threads.max(1) }));
        let threads = (0..threads.max(1))
            .map(|_| {
                let (pool, segments, profile_dir) = (pool.clone(), segments.clone(), profile_dir.clone());
                std::thread::spawn(move || pool.work(Router::with_segments(segments, profile_dir)))
            })
            .collect();
        Self { pool, threads }
    }

    /// Answers the request (see `Router::answer`) on a free thread and hands the outcome and the time
    /// taken to `reply`, on that thread.
    pub fn submit(
        &self,
        query: String,
        max_running_time: i64,
        reply: impl FnOnce(Outcome, Duration) + Send + 'static,
    ) {
        let mut queue = self.pool.queue();
        queue.requests.push_back(Request { query, max_running_time, reply: Box::new(reply) });
        drop(queue);
        self.pool.0.work.notify_one();
    }

    /// Answers the requests submitted so far, then stops the threads.
    pub fn finish(self) {
        self.pool.queue().closed = true;
        self.pool.0.work.notify_all();
        for thread in self.threads {
            thread.join().expect("pool thread");
        }
    }
}

/// The pool as the searches of a request see it.
#[derive(Clone)]
pub(crate) struct Pool(Arc<Shared>);

struct Shared {
    queue: Mutex<Queue>,
    work: Condvar,
    threads: usize,
}

#[derive(Default)]
struct Queue {
    /// Searches of requests in progress, which wait for them: they go first.
    batches: VecDeque<Arc<Batch>>,
    requests: VecDeque<Request>,
    /// Requests being answered: they may still add searches.
    answering: usize,
    closed: bool,
}

struct Request {
    query: String,
    max_running_time: i64,
    reply: Reply,
}

enum Task {
    Batch(Arc<Batch>),
    Request(Request),
}

/// Every critical section leaves the data consistent, so a panic elsewhere does not poison it.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Pool {
    pub(crate) fn threads(&self) -> usize {
        self.0.threads
    }

    fn queue(&self) -> MutexGuard<'_, Queue> {
        lock(&self.0.queue)
    }

    fn work(&self, mut router: Router) {
        while let Some(task) = self.next_task() {
            match task {
                Task::Batch(batch) => batch.help(|job| router.run_job(job)),
                Task::Request(request) => {
                    let start = Instant::now();
                    let outcome = catch_unwind(AssertUnwindSafe(|| {
                        router.answer_in(&request.query, request.max_running_time, Some(self))
                    }));
                    let time = start.elapsed();
                    // the request adds no more searches, whatever its reply does
                    self.queue().answering -= 1;
                    self.0.work.notify_all();
                    (request.reply)(outcome, time);
                }
            }
        }
    }

    fn next_task(&self) -> Option<Task> {
        let mut queue = self.queue();
        loop {
            if let Some(batch) = queue.batches.pop_front() {
                return Some(Task::Batch(batch));
            }
            if let Some(request) = queue.requests.pop_front() {
                queue.answering += 1;
                return Some(Task::Request(request));
            }
            if queue.closed && queue.answering == 0 {
                return None;
            }
            queue = self.0.work.wait(queue).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Runs the jobs on the free threads and with `local` on this one; returns their results in order.
    pub(crate) fn run(&self, jobs: Vec<Job>, mut local: impl FnMut(Job) -> JobResult) -> Vec<JobResult> {
        let helpers = jobs.len().saturating_sub(1).min(self.0.threads - 1);
        let batch = Arc::new(Batch::new(jobs));
        if helpers > 0 {
            let mut queue = self.queue();
            queue.batches.extend(std::iter::repeat_n(&batch, helpers).cloned());
            drop(queue);
            self.0.work.notify_all();
        }
        let results = batch.finish(&mut local);
        self.queue().batches.retain(|b| !Arc::ptr_eq(b, &batch));
        results
    }
}

/// The jobs of one request and their results.
struct Batch {
    state: Mutex<BatchState>,
    changed: Condvar,
}

struct BatchState {
    /// Jobs not started yet, with their index.
    jobs: VecDeque<(usize, Job)>,
    results: Vec<Option<JobResult>>,
    pending: usize,
}

impl Batch {
    fn new(jobs: Vec<Job>) -> Self {
        let pending = jobs.len();
        let state = BatchState {
            jobs: jobs.into_iter().enumerate().collect(),
            results: (0..pending).map(|_| None).collect(),
            pending,
        };
        Self { state: Mutex::new(state), changed: Condvar::new() }
    }

    fn take(&self) -> Option<(usize, Job)> {
        lock(&self.state).jobs.pop_front()
    }

    fn done(&self, i: usize, result: JobResult) {
        let mut state = lock(&self.state);
        state.results[i] = Some(result);
        state.pending -= 1;
        drop(state);
        self.changed.notify_all();
    }

    /// A pool thread's part: runs jobs until none is left, or until one cannot run on this thread
    /// (`run` hands it back), which goes back to the request's thread. An internal error (panic)
    /// outside the job's search ends the job with its message, so the request never waits for it.
    fn help(&self, mut run: impl FnMut(Job) -> Result<JobResult, Box<Job>>) {
        while let Some((i, job)) = self.take() {
            match catch_unwind(AssertUnwindSafe(|| run(job))) {
                Ok(Ok(result)) => self.done(i, result),
                Ok(Err(job)) => {
                    lock(&self.state).jobs.push_back((i, *job));
                    self.changed.notify_all();
                    return;
                }
                Err(panic) => self.done(i, JobResult::panicked(&*panic)),
            }
        }
    }

    /// The request's part: runs the jobs left, then waits for the others.
    fn finish(&self, local: &mut impl FnMut(Job) -> JobResult) -> Vec<JobResult> {
        let mut state = lock(&self.state);
        loop {
            if let Some((i, job)) = state.jobs.pop_front() {
                drop(state);
                self.done(i, local(job));
                state = lock(&self.state);
            } else if state.pending == 0 {
                return state.results.iter_mut().map(|r| r.take().expect("finished job")).collect();
            } else {
                state = self.changed.wait(state).unwrap_or_else(PoisonError::into_inner);
            }
        }
    }
}
