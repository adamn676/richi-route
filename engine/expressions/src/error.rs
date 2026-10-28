use std::fmt;

/// An error from loading a lookup table, parsing a profile or evaluating it. The message is the one
/// BRouter's exception carries (`getMessage()`), e.g.
/// `ParseException trekking.brf at line 12: unknown lookup name: foo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpressionError(pub String);

impl fmt::Display for ExpressionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ExpressionError {}

/// A Java exception inside the crate: its class decides how callers wrap it.
#[derive(Debug)]
pub(crate) struct Failure {
    class: &'static str,
    message: String,
}

impl Failure {
    pub(crate) fn new(class: &'static str, message: impl Into<String>) -> Self {
        Self { class, message: message.into() }
    }

    pub(crate) fn illegal_argument(message: impl Into<String>) -> Self {
        Self::new("java.lang.IllegalArgumentException", message)
    }

    pub(crate) fn number_format(message: impl Into<String>) -> Self {
        Self::new("java.lang.NumberFormatException", message)
    }

    /// `catch (IllegalArgumentException e)` also catches its subclass `NumberFormatException`.
    pub(crate) fn is_illegal_argument(&self) -> bool {
        matches!(self.class, "java.lang.IllegalArgumentException" | "java.lang.NumberFormatException")
    }

    /// `getMessage()`.
    pub(crate) fn message(self) -> ExpressionError {
        ExpressionError(self.message)
    }

    /// `new RuntimeException(e).getMessage()`, which is `e.toString()`.
    pub(crate) fn wrapped(self) -> ExpressionError {
        if self.message.is_empty() {
            ExpressionError(self.class.to_string())
        } else {
            ExpressionError(format!("{}: {}", self.class, self.message))
        }
    }
}
