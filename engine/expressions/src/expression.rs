//! Port of `BExpression`: parsing, constant folding and evaluation of profile expressions.
//!
//! Java builds a tree of `BExpression` objects in which folding can share a node between several
//! parents. Here the nodes live in the context's arena (`ExpressionContext::exprs`) and refer to each
//! other by index, so sharing works the same way.

use crate::context::{ExpressionContext, LookupValue};
use crate::error::Failure;
use crate::java;

pub(crate) type ExprId = u32;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Op {
    Or,
    And,
    Not,
    Add,
    Multiply,
    Divide,
    Max,
    Equal,
    Greater,
    Min,
    Sub,
    Lesser,
    Xor,
    Switch,
    Assign,
    Lookup,
    Number,
    Variable,
    ForeignVariable,
    VariableGet,
}

pub(crate) struct Expr {
    op: Op,
    op1: Option<ExprId>,
    op2: Option<ExprId>,
    op3: Option<ExprId>,
    number_value: f32,
    variable_idx: usize,
    lookup_name_idx: i32,
    lookup_value_idx_array: Box<[i32]>,
    do_not_change: bool,
}

impl Expr {
    fn new(op: Op) -> Self {
        Self {
            op,
            op1: None,
            op2: None,
            op3: None,
            number_value: 0.0,
            variable_idx: 0,
            lookup_name_idx: -1,
            lookup_value_idx_array: Box::new([]),
            do_not_change: false,
        }
    }

    fn number(value: f32) -> Self {
        Self { number_value: value, ..Self::new(Op::Number) }
    }
}

/// An exception thrown while evaluating; Java throws these from `BExpression.evaluate`.
#[derive(Clone, Copy, Debug)]
pub(crate) enum EvalError {
    /// `divide` by zero: an `IllegalArgumentException`.
    DivByZero,
    /// `v:` with a name that is not in the lookup table reads `lookupData[-1]`.
    IndexOutOfBounds { index: i32, length: usize },
    /// A `way:` variable read while the way context has no current values.
    NoForeignValues,
}

impl From<EvalError> for Failure {
    fn from(e: EvalError) -> Self {
        match e {
            EvalError::DivByZero => Failure::illegal_argument("div by zero"),
            EvalError::IndexOutOfBounds { index, length } => Failure::new(
                "java.lang.ArrayIndexOutOfBoundsException",
                format!("Index {index} out of bounds for length {length}"),
            ),
            EvalError::NoForeignValues => Failure::new(
                "java.lang.NullPointerException",
                "Cannot load from float array because \"this.currentVars\" is null",
            ),
        }
    }
}

/// What an evaluation reads besides the variables.
pub(crate) struct Env<'a> {
    pub(crate) lookup_data: &'a [i32],
    pub(crate) lookup_values: &'a [Vec<LookupValue>],
    /// The foreign (way) context's current build-in values, starting at its current offset.
    pub(crate) foreign: Option<&'a [f32]>,
}

const NO_ENV: Env<'static> = Env { lookup_data: &[], lookup_values: &[], foreign: None };

/// `BExpression.evaluate`.
pub(crate) fn evaluate(exprs: &[Expr], id: ExprId, vars: &mut [f32], env: &Env) -> Result<f32, EvalError> {
    let e = &exprs[id as usize];
    let mut operand = |op: Option<ExprId>| evaluate(exprs, op.expect("operator has its operands"), vars, env);
    let truth = |b: bool| if b { 1.0 } else { 0.0 };
    Ok(match e.op {
        Op::Or => truth(operand(e.op1)? != 0.0 || operand(e.op2)? != 0.0),
        Op::Xor => truth((operand(e.op1)? != 0.0) ^ (operand(e.op2)? != 0.0)),
        Op::And => truth(operand(e.op1)? != 0.0 && operand(e.op2)? != 0.0),
        Op::Add => operand(e.op1)? + operand(e.op2)?,
        Op::Sub => operand(e.op1)? - operand(e.op2)?,
        Op::Multiply => operand(e.op1)? * operand(e.op2)?,
        Op::Divide => {
            let (v1, v2) = (operand(e.op1)?, operand(e.op2)?);
            if v2 == 0.0 {
                return Err(EvalError::DivByZero);
            }
            v1 / v2
        }
        // Java's `v1 > v2 ? v1 : v2`, which differs from f32::max for NaN and signed zeros.
        Op::Max => {
            let (v1, v2) = (operand(e.op1)?, operand(e.op2)?);
            if v1 > v2 { v1 } else { v2 }
        }
        Op::Min => {
            let (v1, v2) = (operand(e.op1)?, operand(e.op2)?);
            if v1 < v2 { v1 } else { v2 }
        }
        Op::Equal => truth(operand(e.op1)? == operand(e.op2)?),
        Op::Greater => truth(operand(e.op1)? > operand(e.op2)?),
        Op::Lesser => truth(operand(e.op1)? < operand(e.op2)?),
        Op::Switch => {
            if operand(e.op1)? != 0.0 {
                operand(e.op2)?
            } else {
                operand(e.op3)?
            }
        }
        Op::Assign => {
            let value = operand(e.op1)?;
            vars[e.variable_idx] = value;
            value
        }
        Op::Lookup => {
            let actual = env.lookup_data[e.lookup_name_idx as usize];
            truth(e.lookup_value_idx_array.contains(&actual))
        }
        Op::Number => e.number_value,
        Op::Variable => vars[e.variable_idx],
        Op::ForeignVariable => env.foreign.ok_or(EvalError::NoForeignValues)?[e.variable_idx],
        Op::VariableGet => lookup_value(env, e.lookup_name_idx)?,
        Op::Not => truth(operand(e.op1)? == 0.0),
    })
}

/// Whether evaluating the top-level `list` in order depends on the lookup data alone: no foreign
/// variable is read, and no variable at or above `min_write_idx` (the context's own) is read before
/// the list assigns it, so nothing carries over from an earlier evaluation.
pub(crate) fn depends_on_lookups_only(
    exprs: &[Expr],
    list: &[ExprId],
    variable_count: usize,
    min_write_idx: usize,
) -> bool {
    fn reads_only(exprs: &[Expr], id: ExprId, assigned: &[bool]) -> bool {
        let e = &exprs[id as usize];
        let own = match e.op {
            Op::Variable => assigned[e.variable_idx],
            Op::ForeignVariable | Op::Assign => false,
            _ => true,
        };
        own && [e.op1, e.op2, e.op3].into_iter().flatten().all(|op| reads_only(exprs, op, assigned))
    }
    // the read-only variables of the global section never change while evaluating
    let mut assigned: Vec<bool> = (0..variable_count).map(|i| i < min_write_idx).collect();
    list.iter().all(|&id| {
        let e = &exprs[id as usize];
        if e.op != Op::Assign {
            return reads_only(exprs, id, &assigned);
        }
        let ok = e.op1.is_some_and(|op| reads_only(exprs, op, &assigned));
        assigned[e.variable_idx] = true;
        ok
    })
}

/// `BExpressionContext.getLookupValue(int)`: the number behind a lookup value, for `v:` expressions.
pub(crate) fn lookup_value(env: &Env, key: i32) -> Result<f32, EvalError> {
    let Some(&val) = usize::try_from(key).ok().and_then(|k| env.lookup_data.get(k)) else {
        return Err(EvalError::IndexOutOfBounds { index: key, length: env.lookup_data.len() });
    };
    Ok(if val == 0 {
        f32::NAN
    } else if val < 900 {
        env.lookup_values[key as usize][val as usize].number
    } else {
        val.wrapping_sub(1000) as f32 / 100.0
    })
}

/// Parses one context's expressions from a profile text: `BExpression.parse` together with the token
/// reader of `BExpressionContext`.
pub(crate) struct Parser<'a> {
    ctx: &'a mut ExpressionContext,
    /// The way context while parsing a node context, for `way:` variables.
    foreign: Option<&'a mut ExpressionContext>,
    chars: std::str::Chars<'a>,
}

impl<'a> Parser<'a> {
    pub(crate) fn new(
        ctx: &'a mut ExpressionContext,
        foreign: Option<&'a mut ExpressionContext>,
        text: &'a str,
    ) -> Self {
        Self { ctx, foreign, chars: text.chars() }
    }

    fn push(&mut self, e: Expr) -> ExprId {
        self.ctx.exprs.push(e);
        (self.ctx.exprs.len() - 1) as ExprId
    }

    fn expr(&self, id: ExprId) -> &Expr {
        &self.ctx.exprs[id as usize]
    }

    /// `_parseFile` after opening the file: assignments for the injected key values, then every
    /// top-level expression of the context.
    pub(crate) fn parse_all(&mut self, key_values: &[(String, String)]) -> Result<Vec<ExprId>, Failure> {
        let mut result = Vec::new();
        for (key, value) in key_values {
            result.push(self.create_assign_expression_from_key_value(key, value)?);
        }
        while let Some(exp) = self.parse(0, None)? {
            result.push(exp);
        }
        Ok(result)
    }

    /// `BExpression.createAssignExpressionFromKeyValue`.
    fn create_assign_expression_from_key_value(&mut self, key: &str, value: &str) -> Result<ExprId, Failure> {
        let variable_idx = self.ctx.create_variable(key);
        let number = java::parse_float(value).map_err(Failure::number_format)?;
        let op1 = self.push(Expr { do_not_change: true, ..Expr::number(number) });
        self.ctx.last_assigned_expression[variable_idx] = Some(op1);
        Ok(self.push(Expr { variable_idx, op1: Some(op1), ..Expr::new(Op::Assign) }))
    }

    fn parse(&mut self, level: i32, optional_token: Option<&str>) -> Result<Option<ExprId>, Failure> {
        let Some(mut e) = self.parse_raw(level, optional_token)? else {
            return Ok(None);
        };
        if self.expr(e).op == Op::Assign {
            // manage assigned and injected values
            let (variable_idx, op1) = (self.expr(e).variable_idx, self.expr(e).op1);
            let assigned_before = self.ctx.last_assigned_expression[variable_idx];
            let mut assigned = op1;
            if let Some(before) = assigned_before.filter(|&b| self.expr(b).do_not_change) {
                self.ctx.exprs[e as usize].op1 = Some(before); // was injected as key-value
                self.ctx.exprs[before as usize].do_not_change = false; // protect just once
                assigned = Some(before);
            }
            self.ctx.last_assigned_expression[variable_idx] = assigned;
        } else if self.expr(e).op == Op::Variable {
            // try to simplify the expression
            if let Some(ae) = self.ctx.last_assigned_expression[self.expr(e).variable_idx]
                && self.expr(ae).op == Op::Number
            {
                e = ae;
            }
        } else {
            e = self.try_collapse(e);
            e = self.try_evaluate_constant(e)?;
        }
        if level == 0 {
            // mark the used lookups after the expression is collapsed, so lookups that constant
            // expressions de-activate do not count
            let node_count = self.mark_lookup_idx_used(e);
            self.ctx.expression_node_count += node_count;
        }
        Ok(Some(e))
    }

    fn mark_lookup_idx_used(&mut self, id: ExprId) -> i32 {
        let e = self.expr(id);
        let (lookup_name_idx, ops) = (e.lookup_name_idx, [e.op1, e.op2, e.op3]);
        if lookup_name_idx >= 0 {
            self.ctx.lookup_idx_used[lookup_name_idx as usize] = true;
        }
        1 + ops.into_iter().flatten().map(|op| self.mark_lookup_idx_used(op)).sum::<i32>()
    }

    fn parse_raw(&mut self, level: i32, optional_token: Option<&str>) -> Result<Option<ExprId>, Failure> {
        let mut brackets = false;
        let mut operator = self.parse_token()?;
        if optional_token.is_some() && optional_token == operator.as_deref() {
            operator = self.parse_token()?;
        }
        if operator.as_deref() == Some("(") {
            brackets = true;
            operator = self.parse_token()?;
        }
        let Some(operator) = operator else {
            return if level == 0 { Ok(None) } else { Err(Failure::illegal_argument("unexpected end of file")) };
        };
        if level == 0 && operator != "assign" {
            return Err(Failure::illegal_argument(format!(
                "operator {operator} is invalid on toplevel (only 'assign' allowed)"
            )));
        }

        let mut exp = Expr::new(Op::Number);
        let mut if_then_else = false;
        let (op, nops) = match operator.as_str() {
            "switch" => (Op::Switch, 3),
            "if" => {
                if_then_else = true;
                (Op::Switch, 3)
            }
            "or" => (Op::Or, 2),
            "and" => (Op::And, 2),
            "multiply" => (Op::Multiply, 2),
            "divide" => (Op::Divide, 2),
            "add" => (Op::Add, 2),
            "max" => (Op::Max, 2),
            "min" => (Op::Min, 2),
            "equal" => (Op::Equal, 2),
            "greater" => (Op::Greater, 2),
            "sub" => (Op::Sub, 2),
            "lesser" => (Op::Lesser, 2),
            "xor" => (Op::Xor, 2),
            "assign" => {
                if level > 0 {
                    return Err(Failure::illegal_argument("assign operator within expression"));
                }
                let variable =
                    self.parse_token()?.ok_or_else(|| Failure::illegal_argument("unexpected end of file"))?;
                if variable.contains('=') {
                    return Err(Failure::illegal_argument(format!("variable name cannot contain '=': {variable}")));
                }
                if variable.contains(':') {
                    return Err(Failure::illegal_argument(format!(
                        "cannot assign context-prefixed variable: {variable}"
                    )));
                }
                exp.variable_idx = self.ctx.create_variable(&variable);
                if exp.variable_idx < self.ctx.min_write_idx {
                    return Err(Failure::illegal_argument(format!("cannot assign to readonly variable {variable}")));
                }
                (Op::Assign, 1)
            }
            "not" => (Op::Not, 1),
            _ => (self.parse_elementary(&operator, &mut exp)?, 0),
        };
        exp.op = op;

        // parse operands
        if nops > 0 {
            exp.op1 = self.parse(level + 1, (op == Op::Assign).then_some("="))?;
        }
        if nops > 1 {
            if if_then_else {
                self.check_expected_token("then")?;
            }
            exp.op2 = self.parse(level + 1, None)?;
        }
        if nops > 2 {
            if if_then_else {
                self.check_expected_token("else")?;
            }
            exp.op3 = self.parse(level + 1, None)?;
        }
        if brackets {
            self.check_expected_token(")")?;
        }
        Ok(Some(self.push(exp)))
    }

    /// Lookups (`name=value|value`), `v:` lookup values, foreign variables, variables and numbers.
    fn parse_elementary(&mut self, operator: &str, exp: &mut Expr) -> Result<Op, Failure> {
        if let Some((name, values)) = operator.split_once('=') {
            exp.lookup_name_idx = self.ctx.lookup_key(name);
            if exp.lookup_name_idx < 0 {
                return Err(Failure::illegal_argument(format!("unknown lookup name: {name}")));
            }
            // StringTokenizer skips empty tokens; no token at all means the empty value
            let mut tokens: Vec<&str> = values.split('|').filter(|t| !t.is_empty()).collect();
            if tokens.is_empty() {
                tokens.push("");
            }
            let mut idx_array = Vec::with_capacity(tokens.len());
            for value in tokens {
                let idx = self.ctx.get_lookup_value_idx(exp.lookup_name_idx as usize, value);
                if idx < 0 {
                    return Err(Failure::illegal_argument(format!("unknown lookup value: {value}")));
                }
                idx_array.push(idx);
            }
            exp.lookup_value_idx_array = idx_array.into_boxed_slice();
            return Ok(Op::Lookup);
        }
        if let Some((context, variable)) = operator.split_once(':') {
            if let Some(name) = operator.strip_prefix("v:") {
                exp.lookup_name_idx = self.ctx.lookup_key(name);
                return Ok(Op::VariableGet);
            }
            exp.variable_idx = self.get_foreign_variable_idx(context, variable)?;
            return Ok(Op::ForeignVariable);
        }
        let idx = self.ctx.variable_idx(operator);
        if idx >= 0 {
            exp.variable_idx = idx as usize;
            return Ok(Op::Variable);
        }
        exp.number_value = match operator {
            "true" => 1.0,
            "false" => 0.0,
            _ => java::parse_float(operator)
                .map_err(|_| Failure::illegal_argument(format!("unknown expression: {operator}")))?,
        };
        Ok(Op::Number)
    }

    /// `BExpressionContext.getForeignVariableIdx`.
    fn get_foreign_variable_idx(&mut self, context: &str, name: &str) -> Result<usize, Failure> {
        match self.foreign.as_deref_mut() {
            Some(foreign) if foreign.context == context => foreign.register_output_variable(name, true),
            _ => Err(Failure::illegal_argument(format!("unknown foreign context: {context}"))),
        }
    }

    fn check_expected_token(&mut self, expected: &str) -> Result<(), Failure> {
        let token = self.parse_token()?;
        if token.as_deref() != Some(expected) {
            let token = token.as_deref().unwrap_or("null");
            return Err(Failure::illegal_argument(format!("unexpected token: {token}, expected: {expected}")));
        }
        Ok(())
    }

    /// Try to collapse the expression if logically possible.
    fn try_collapse(&self, id: ExprId) -> ExprId {
        let e = self.expr(id);
        let constant =
            |op: Option<ExprId>| op.map(|op| self.expr(op)).filter(|o| o.op == Op::Number).map(|o| o.number_value);
        let (op1, op2, op3) = (e.op1.unwrap_or(id), e.op2.unwrap_or(id), e.op3.unwrap_or(id));
        match (e.op, constant(e.op1), constant(e.op2)) {
            (Op::Or, Some(v1), _) => {
                if v1 != 0.0 {
                    op1
                } else {
                    op2
                }
            }
            (Op::Or, None, Some(v2)) => {
                if v2 != 0.0 {
                    op2
                } else {
                    op1
                }
            }
            (Op::And, Some(v1), _) => {
                if v1 == 0.0 {
                    op1
                } else {
                    op2
                }
            }
            (Op::And, None, Some(v2)) => {
                if v2 == 0.0 {
                    op2
                } else {
                    op1
                }
            }
            (Op::Add, Some(v1), _) => {
                if v1 == 0.0 {
                    op2
                } else {
                    id
                }
            }
            (Op::Add, None, Some(v2)) => {
                if v2 == 0.0 {
                    op1
                } else {
                    id
                }
            }
            (Op::Switch, Some(v1), _) => {
                if v1 == 0.0 {
                    op3
                } else {
                    op2
                }
            }
            _ => id,
        }
    }

    /// Try to evaluate the expression if all operands are constant.
    fn try_evaluate_constant(&mut self, id: ExprId) -> Result<ExprId, Failure> {
        let e = self.expr(id);
        let constant = |op: Option<ExprId>| op.is_none_or(|op| self.expr(op).op == Op::Number);
        if e.op1.is_some() && constant(e.op1) && constant(e.op2) && constant(e.op3) {
            let value = evaluate(&self.ctx.exprs, id, &mut [], &NO_ENV)?;
            return Ok(self.push(Expr::number(value)));
        }
        Ok(id)
    }

    /// `BExpressionContext.parseToken`: the next token of this context, handling the context and model
    /// tags.
    fn parse_token(&mut self) -> Result<Option<String>, Failure> {
        const CONTEXT_TAG: &str = "---context:";
        const MODEL_TAG: &str = "---model:";
        loop {
            let Some(token) = self.read_token()? else {
                return Ok(None);
            };
            if let Some(context) = token.strip_prefix(CONTEXT_TAG) {
                self.ctx.in_our_context = context == self.ctx.context;
            } else if let Some(model) = token.strip_prefix(MODEL_TAG) {
                self.ctx.model_class = Some(java::trim(model).to_string());
            } else if self.ctx.in_our_context {
                return Ok(Some(token));
            }
        }
    }

    /// `BExpressionContext._parseToken`: the next whitespace-separated token, skipping `#` comments
    /// and picking up the `noStartWay` comment.
    fn read_token(&mut self) -> Result<Option<String>, Failure> {
        let mut sb = String::new();
        let mut sbcom = String::new();
        let mut in_comment = false;
        loop {
            // at the end, the last token, then None from then on (Java's _readerDone)
            let Some(c) = self.chars.next() else {
                return Ok((!sb.is_empty()).then_some(sb));
            };
            if c == '\n' {
                self.ctx.linenr += 1;
            }
            if in_comment {
                sbcom.push(c);
                if c == '\r' || c == '\n' {
                    in_comment = false;
                    self.check_no_start_way_comment(&sbcom)?;
                    sbcom.clear();
                }
                continue;
            }
            if java::is_whitespace(c) {
                if !sb.is_empty() {
                    return Ok(Some(sb));
                }
                continue;
            }
            if c == '#' && sb.is_empty() {
                in_comment = true;
            } else {
                sb.push(c);
            }
        }
    }

    /// A comment like `# ... | ... | ... | noStartWay=highway,motorway;highway,trunk` lists ways the
    /// router must not start on, once the profile has a `check_start_way` variable.
    fn check_no_start_way_comment(&mut self, comment: &str) -> Result<(), Failure> {
        if !self.ctx.variable_numbers.contains_key("check_start_way")
            || !self.ctx.no_start_ways.is_empty()
            || !comment.contains("noStartWay")
        {
            return Ok(());
        }
        let parts = java::split(java::trim(comment), '|');
        if parts.len() != 4 {
            return Ok(());
        }
        let list = java::trim(&parts[3][parts[3].find('=').map_or(0, |i| i + 1)..]);
        for entry in java::split(list, ';') {
            let pair = java::split(entry, ',');
            if pair.len() < 2 {
                return Err(Failure::new(
                    "java.lang.ArrayIndexOutOfBoundsException",
                    format!("Index {} out of bounds for length {}", pair.len().min(1), pair.len()),
                ));
            }
            let name_idx = self.ctx.lookup_key(pair[0]);
            if name_idx == -1 {
                break;
            }
            let value_idx = self.ctx.get_lookup_value_idx(name_idx as usize, pair[1]);
            self.ctx.no_start_ways.push((name_idx as usize, value_idx));
        }
        Ok(())
    }
}
