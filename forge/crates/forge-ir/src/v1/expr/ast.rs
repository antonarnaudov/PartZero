//! The expression AST (SPEC-v1 §2.3 [D-8]).
//!
//! Parentheses are not nodes: `(a + b) * c` and the canonical text print the same tree, which
//! is what makes `parse(canonical(e)) == e` hold. Number literals are never negative (a minus
//! sign is always a [`UnaryOp::Neg`] node) and always finite.

/// A unit suffix of a number literal (§2.3: `mm`, `cm`, `in`, `deg`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Unit {
    Mm,
    Cm,
    In,
    Deg,
}

impl Unit {
    /// All units, in grammar order.
    pub const ALL: [Unit; 4] = [Unit::Mm, Unit::Cm, Unit::In, Unit::Deg];

    /// The spelling in expression text.
    pub fn as_str(self) -> &'static str {
        match self {
            Unit::Mm => "mm",
            Unit::Cm => "cm",
            Unit::In => "in",
            Unit::Deg => "deg",
        }
    }

    /// The unit named `s`, if `s` is exactly a unit spelling.
    pub fn parse(s: &str) -> Option<Unit> {
        Unit::ALL.into_iter().find(|u| u.as_str() == s)
    }

    /// The conversion factor to mm or degrees (§2.7 rule 2: one multiplication), or `None`
    /// for the identity units `mm` and `deg`.
    pub fn factor(self) -> Option<f64> {
        match self {
            Unit::Cm => Some(10.0),
            Unit::In => Some(25.4),
            Unit::Mm | Unit::Deg => None,
        }
    }

    /// `true` for `deg` (an angle), `false` for the length units.
    pub fn is_angle(self) -> bool {
        self == Unit::Deg
    }
}

/// A prefix operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnaryOp {
    /// `-x`
    Neg,
    /// `!b`
    Not,
}

impl UnaryOp {
    pub fn symbol(self) -> &'static str {
        match self {
            UnaryOp::Neg => "-",
            UnaryOp::Not => "!",
        }
    }
}

/// An infix operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BinaryOp {
    Or,
    And,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
}

impl BinaryOp {
    /// Every operator, lowest precedence first.
    pub const ALL: [BinaryOp; 14] = [
        BinaryOp::Or,
        BinaryOp::And,
        BinaryOp::Lt,
        BinaryOp::Le,
        BinaryOp::Gt,
        BinaryOp::Ge,
        BinaryOp::Eq,
        BinaryOp::Ne,
        BinaryOp::Add,
        BinaryOp::Sub,
        BinaryOp::Mul,
        BinaryOp::Div,
        BinaryOp::Rem,
        BinaryOp::Pow,
    ];

    pub fn symbol(self) -> &'static str {
        match self {
            BinaryOp::Or => "||",
            BinaryOp::And => "&&",
            BinaryOp::Lt => "<",
            BinaryOp::Le => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Ge => ">=",
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Rem => "%",
            BinaryOp::Pow => "^",
        }
    }

    /// `<`, `<=`, `>`, `>=`, `==`, `!=`.
    pub fn is_comparison(self) -> bool {
        matches!(
            self,
            BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge | BinaryOp::Eq | BinaryOp::Ne
        )
    }

    /// The precedence level of §2.4 rule 3 (see [`Level`]).
    pub(crate) fn level(self) -> Level {
        match self {
            BinaryOp::Or => Level::Or,
            BinaryOp::And => Level::And,
            BinaryOp::Add | BinaryOp::Sub => Level::Add,
            BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => Level::Mul,
            BinaryOp::Pow => Level::Pow,
            _ => Level::Cmp,
        }
    }
}

/// Precedence levels of §2.4 rule 3, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Level {
    Cond,
    Or,
    And,
    Cmp,
    Add,
    Mul,
    Unary,
    Pow,
    Atom,
}

/// An expression tree.
///
/// `PartialEq` compares numbers with `==`, so `-0` equals `0`: the canonical printer writes
/// both as `0` (§2.4 rule 1).
///
/// **Stack safety.** A tree that [`super::parse`] accepts can be about 2048 levels high (a flat
/// 4096-byte chain `1+1+…+1` is left-deep), so `Clone`, `PartialEq` and `Drop` are implemented
/// with explicit stacks instead of the derived recursion (which needs more than 1 MiB of stack,
/// the wasm32 default, for such a tree in a debug build). `Debug` stays derived (diagnostics
/// only).
#[derive(Debug)]
pub enum Expr {
    /// A non-negative, finite number literal with an optional unit (`12`, `0.25 in`).
    Num {
        value: f64,
        unit: Option<Unit>,
    },
    /// `true` or `false`.
    Bool(bool),
    /// A parameter name or the constant `PI`.
    Ident(String),
    /// A function call `name(args…)` (the name is checked by the type checker, not the parser).
    Call {
        name: String,
        args: Vec<Expr>,
    },
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    /// `cond ? then : otherwise`.
    Cond {
        cond: Box<Expr>,
        then: Box<Expr>,
        otherwise: Box<Expr>,
    },
}

impl Clone for Expr {
    fn clone(&self) -> Expr {
        // Post-order over an explicit stack: children are cloned onto `done` left to right,
        // then their parent takes them back.
        enum Step<'a> {
            Visit(&'a Expr),
            Build(&'a Expr),
        }
        let mut todo = vec![Step::Visit(self)];
        let mut done: Vec<Expr> = Vec::new();
        while let Some(step) = todo.pop() {
            match step {
                Step::Visit(e) => match e {
                    Expr::Num { value, unit } => done.push(Expr::Num {
                        value: *value,
                        unit: *unit,
                    }),
                    Expr::Bool(b) => done.push(Expr::Bool(*b)),
                    Expr::Ident(n) => done.push(Expr::Ident(n.clone())),
                    _ => {
                        todo.push(Step::Build(e));
                        let kids = e.children();
                        todo.extend(kids.into_iter().rev().map(Step::Visit));
                    }
                },
                Step::Build(e) => {
                    let n = e.children().len();
                    let mut kids = done.split_off(done.len() - n).into_iter();
                    let mut next = || kids.next().expect("every child was cloned");
                    let built = match e {
                        Expr::Call { name, args } => Expr::Call {
                            name: name.clone(),
                            args: (0..args.len()).map(|_| next()).collect(),
                        },
                        Expr::Unary { op, .. } => Expr::unary(*op, next()),
                        Expr::Binary { op, .. } => {
                            let l = next();
                            Expr::binary(*op, l, next())
                        }
                        Expr::Cond { .. } => {
                            let c = next();
                            let t = next();
                            Expr::cond(c, t, next())
                        }
                        Expr::Num { .. } | Expr::Bool(_) | Expr::Ident(_) => {
                            unreachable!("leaves are cloned when visited")
                        }
                    };
                    done.push(built);
                }
            }
        }
        done.pop().expect("the root was cloned")
    }
}

impl PartialEq for Expr {
    fn eq(&self, other: &Expr) -> bool {
        let mut todo = vec![(self, other)];
        while let Some(pair) = todo.pop() {
            match pair {
                (Expr::Num { value: x, unit: u }, Expr::Num { value: y, unit: v }) => {
                    #[allow(clippy::float_cmp)] // `-0 == 0`, as documented on the type
                    if x != y || u != v {
                        return false;
                    }
                }
                (Expr::Bool(x), Expr::Bool(y)) => {
                    if x != y {
                        return false;
                    }
                }
                (Expr::Ident(x), Expr::Ident(y)) => {
                    if x != y {
                        return false;
                    }
                }
                (Expr::Call { name: n, args: a }, Expr::Call { name: m, args: b }) => {
                    if n != m || a.len() != b.len() {
                        return false;
                    }
                    todo.extend(a.iter().zip(b));
                }
                (Expr::Unary { op: o, operand: x }, Expr::Unary { op: p, operand: y }) => {
                    if o != p {
                        return false;
                    }
                    todo.push((x, y));
                }
                (
                    Expr::Binary {
                        op: o,
                        lhs: l1,
                        rhs: r1,
                    },
                    Expr::Binary {
                        op: p,
                        lhs: l2,
                        rhs: r2,
                    },
                ) => {
                    if o != p {
                        return false;
                    }
                    todo.push((r1, r2));
                    todo.push((l1, l2));
                }
                (
                    Expr::Cond {
                        cond: c1,
                        then: t1,
                        otherwise: o1,
                    },
                    Expr::Cond {
                        cond: c2,
                        then: t2,
                        otherwise: o2,
                    },
                ) => {
                    todo.push((o1, o2));
                    todo.push((t1, t2));
                    todo.push((c1, c2));
                }
                _ => return false,
            }
        }
        true
    }
}

impl Drop for Expr {
    fn drop(&mut self) {
        // Detach the children onto a stack and drop them one by one, each already childless,
        // so dropping never recurses more than one level.
        fn detach(e: &mut Expr, out: &mut Vec<Expr>) {
            let mut take =
                |b: &mut Box<Expr>| out.push(std::mem::replace(&mut **b, Expr::Bool(false)));
            match e {
                Expr::Num { .. } | Expr::Bool(_) | Expr::Ident(_) => {}
                Expr::Call { args, .. } => out.append(args),
                Expr::Unary { operand, .. } => take(operand),
                Expr::Binary { lhs, rhs, .. } => {
                    take(lhs);
                    take(rhs);
                }
                Expr::Cond {
                    cond,
                    then,
                    otherwise,
                } => {
                    take(cond);
                    take(then);
                    take(otherwise);
                }
            }
        }
        let mut stack = Vec::new();
        detach(self, &mut stack);
        while let Some(mut e) = stack.pop() {
            detach(&mut e, &mut stack);
        }
    }
}

impl Expr {
    /// A plain number literal without a unit.
    pub fn num(value: f64) -> Expr {
        Expr::Num { value, unit: None }
    }

    pub fn ident(name: impl Into<String>) -> Expr {
        Expr::Ident(name.into())
    }

    pub fn unary(op: UnaryOp, operand: Expr) -> Expr {
        Expr::Unary {
            op,
            operand: Box::new(operand),
        }
    }

    pub fn binary(op: BinaryOp, lhs: Expr, rhs: Expr) -> Expr {
        Expr::Binary {
            op,
            lhs: Box::new(lhs),
            rhs: Box::new(rhs),
        }
    }

    pub fn cond(cond: Expr, then: Expr, otherwise: Expr) -> Expr {
        Expr::Cond {
            cond: Box::new(cond),
            then: Box::new(then),
            otherwise: Box::new(otherwise),
        }
    }

    pub fn call(name: impl Into<String>, args: Vec<Expr>) -> Expr {
        Expr::Call {
            name: name.into(),
            args,
        }
    }

    /// The precedence level of this node (§2.4 rule 3).
    pub(crate) fn level(&self) -> Level {
        match self {
            Expr::Num { .. } | Expr::Bool(_) | Expr::Ident(_) | Expr::Call { .. } => Level::Atom,
            Expr::Unary { .. } => Level::Unary,
            Expr::Binary { op, .. } => op.level(),
            Expr::Cond { .. } => Level::Cond,
        }
    }

    /// The direct children, left to right (source order).
    pub fn children(&self) -> Vec<&Expr> {
        match self {
            Expr::Num { .. } | Expr::Bool(_) | Expr::Ident(_) => Vec::new(),
            Expr::Call { args, .. } => args.iter().collect(),
            Expr::Unary { operand, .. } => vec![operand],
            Expr::Binary { lhs, rhs, .. } => vec![lhs, rhs],
            Expr::Cond {
                cond,
                then,
                otherwise,
            } => vec![cond, then, otherwise],
        }
    }

    /// The height of the tree (a leaf has height 1). Not bounded by
    /// [`crate::v1::MAX_EXPR_DEPTH`]: a flat chain `1 + 1 + … + 1` of 4096 bytes is about 2048
    /// high (see [`super::parse`]).
    pub fn height(&self) -> u32 {
        // Iterative, so that a (programmatically built) degenerate tree cannot overflow the stack.
        let mut max = 0;
        let mut stack = vec![(self, 1u32)];
        while let Some((e, d)) = stack.pop() {
            max = max.max(d);
            for c in e.children() {
                stack.push((c, d + 1));
            }
        }
        max
    }

    /// Every node in pre-order, left to right: the order in which the nodes' first tokens
    /// appear in the source text.
    pub fn preorder(&self) -> Vec<&Expr> {
        let mut out = Vec::new();
        let mut stack = vec![self];
        while let Some(e) = stack.pop() {
            out.push(e);
            let ch = e.children();
            for c in ch.into_iter().rev() {
                stack.push(c);
            }
        }
        out
    }

    /// The identifiers used as values (not function names), in source order, with repeats.
    pub fn identifiers(&self) -> Vec<&str> {
        self.preorder()
            .into_iter()
            .filter_map(|e| match e {
                Expr::Ident(n) => Some(n.as_str()),
                _ => None,
            })
            .collect()
    }

    /// `Some(n)` when this node is an integer literal without a unit, optionally negated
    /// (parentheses are not nodes): the exponents a dimensioned base accepts (§2.5).
    pub fn integer_literal(&self) -> Option<f64> {
        match self {
            Expr::Num { value, unit: None } if value.fract() == 0.0 => Some(*value),
            Expr::Unary {
                op: UnaryOp::Neg,
                operand,
            } => match operand.as_ref() {
                Expr::Num { value, unit: None } if value.fract() == 0.0 => Some(-*value),
                _ => None,
            },
            _ => None,
        }
    }
}
