import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function createRenderPool(command, args, options, concurrency = 4) {
  const workers = new Set(), queue = [];
  let closed = false;
  const cancellationCheck = setInterval(() => { if (queue.length) dispatch(); }, 100);
  cancellationCheck.unref();
  function rejectQueue(error) {
    for (const job of queue.splice(0)) { clearTimeout(job.timeout); job.reject(error); }
  }
  function startWorker() {
    const child = spawn(command, args, options);
    const worker = { child, job: undefined };
    workers.add(worker);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const job = worker.job;
      if (!job) return;
      worker.job = undefined;
      clearTimeout(job.timeout);
      try {
        const response = JSON.parse(line);
        response.error ? job.reject(new Error(response.error)) : job.resolve(response);
      } catch (error) { job.reject(error); }
      dispatch();
    });
    child.on('error', error => { rejectQueue(error); child.kill(); });
    child.stdin.on('error', () => child.kill());
    child.on('close', () => {
      if (worker.job) {
        clearTimeout(worker.job.timeout);
        worker.job.reject(new Error('Imagery renderer stopped.'));
      }
      workers.delete(worker);
      lines.close();
      dispatch();
    });
    return worker;
  }
  function dispatch() {
    if (closed) return;
    for (const worker of workers) {
      const job = worker.job;
      if (queue.length && job?.cancelled() && Date.now() - job.started > 300) {
        clearTimeout(job.timeout);
        job.reject(new DOMException('Imagery request cancelled.', 'AbortError'));
        worker.job = undefined;
        worker.stopping = true;
        worker.child.kill('SIGTERM');
      }
    }
    while (queue.length) {
      if (queue[0].cancelled()) {
        const job = queue.shift();
        clearTimeout(job.timeout);
        job.reject(new DOMException('Imagery request cancelled.', 'AbortError'));
        continue;
      }
      const worker = [...workers].find(item => !item.job && !item.stopping) ?? (workers.size < concurrency ? startWorker() : undefined);
      if (!worker) return;
      const job = queue.shift();
      worker.job = job;
      job.worker = worker;
      job.started = Date.now();
      worker.child.stdin.write(JSON.stringify(job.request) + '\n');
    }
  }
  return {
    render(request, cancelled = () => false) {
      if (closed) return Promise.reject(new Error('Imagery renderer is closed.'));
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].cancelled()) {
          const job = queue.splice(i, 1)[0];
          clearTimeout(job.timeout);
          job.reject(new DOMException('Imagery request cancelled.', 'AbortError'));
        }
      }
      if (queue.length >= 64) return Promise.reject(new Error('Imagery queue is full.'));
      return new Promise((resolve, reject) => {
        const job = { request, cancelled, resolve, reject };
        job.timeout = setTimeout(() => {
          if (job.worker) { job.worker.stopping = true; job.worker.child.kill('SIGKILL'); }
          else {
            queue.splice(queue.indexOf(job), 1);
            reject(new Error('Imagery request timed out.'));
          }
        }, 60000);
        queue.push(job);
        dispatch();
      });
    },
    close() {
      closed = true;
      clearInterval(cancellationCheck);
      const error = new Error('Imagery service stopped.');
      rejectQueue(error);
      for (const worker of workers) {
        if (worker.job) {
          clearTimeout(worker.job.timeout);
          worker.job.reject(error);
          worker.job = undefined;
        }
        worker.child.kill('SIGTERM');
      }
    },
  };
}
