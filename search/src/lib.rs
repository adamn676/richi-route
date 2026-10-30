//! RichiRoute's address search: the index (`index`), finding places in it (`search`), and building it from the
//! address register and OpenStreetMap (`build`, with the `build` feature). The program in main.rs builds and serves it.

#![forbid(unsafe_code)]

#[cfg(feature = "build")]
pub mod build;
pub mod geo;
pub mod index;
pub mod search;
pub mod text;
