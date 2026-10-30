//! The address search in a browser. JavaScript writes into the buffer that `buffer(length)` returns, then calls
//! `load(length)` with an index file, or `ask(length)` with a request as the server takes it ("/api/?q=Graz&lat=…");
//! `ask` returns the length of the answer, Photon's JSON, now in the buffer at `answer()` (`u32::MAX` for a request it
//! does not know).
//!
//! The exported functions keep their names for JavaScript (`no_mangle`, which Rust counts as unsafe); nothing else here
//! is unsafe, and the search itself forbids unsafe code.

#![deny(unsafe_code)]

use std::sync::Mutex;

use richi_search::index::Index;
use richi_search::photon::{Answer, answer};
use richi_search::search::TypoIndex;

struct State {
    buffer: Vec<u8>,
    search: Option<(Index, TypoIndex)>,
}

static STATE: Mutex<State> = Mutex::new(State { buffer: Vec::new(), search: None });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Room for `length` bytes, and where it starts in the module's memory.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn buffer(length: u32) -> u32 {
    let mut state = state();
    state.buffer.clear();
    state.buffer.resize(length as usize, 0);
    state.buffer.as_mut_ptr() as usize as u32
}

/// Where the buffer starts, holding the last answer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn answer_at() -> u32 {
    state().buffer.as_ptr() as usize as u32
}

/// Reads the index file in the buffer; 1 when it is one.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn load(length: u32) -> u32 {
    let mut state = state();
    let index = Index::read(&state.buffer[..length as usize]);
    state.buffer = Vec::new();
    match index {
        Ok(index) => {
            let typos = TypoIndex::new(&index);
            state.search = Some((index, typos));
            1
        }
        Err(_) => 0,
    }
}

/// Answers the request in the buffer, the answer then in the buffer: its length.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ask(length: u32) -> u32 {
    let mut state = state();
    let State { buffer, search } = &mut *state;
    let Some((index, typos)) = search else { return u32::MAX };
    let request = String::from_utf8_lossy(&buffer[..length as usize]).into_owned();
    let (path, query) = request.split_once('?').unwrap_or((&request, ""));
    match answer(index, typos, path, query) {
        Answer::Json(json) => {
            buffer.clear();
            buffer.extend_from_slice(json.as_bytes());
            json.len() as u32
        }
        Answer::BadRequest(_) | Answer::NotFound => u32::MAX,
    }
}
