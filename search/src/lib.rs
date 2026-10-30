//! RichiRoute's address search: the index (`index`), finding places in it (`search`), answering as Photon does
//! (`photon`), and building it from the address register and OpenStreetMap (`build`, with the `build` feature). The
//! program in main.rs builds and serves it; wasm/ runs it in a browser.

#![forbid(unsafe_code)]

#[cfg(feature = "build")]
pub mod build;
pub mod geo;
pub mod index;
pub mod photon;
pub mod search;
pub mod text;
