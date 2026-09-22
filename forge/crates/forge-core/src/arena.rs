//! Arenas with typed generational ids.
//!
//! Topology lives in [`Arena`]s instead of `Rc<RefCell<…>>` pointer graphs. An entity is
//! addressed by an [`Id<T>`]: a slot index plus a generation counter. Removing an entity
//! bumps its slot's generation, so stale ids are detected (`get` returns `None`) instead
//! of silently aliasing a newer entity.
//!
//! # Determinism
//! - Iteration is always in slot-index order.
//! - Freed slots are reused LIFO, so the same sequence of inserts and removes yields the
//!   same ids on every platform.
//!
//! # Scope
//! Ids are **process-local and arena-local**: never persist them and never use an id
//! from one arena with another. Persistent references use provenance names
//! ([`crate::topo::Provenance::name`]).

use core::cmp::Ordering;
use core::fmt;
use core::hash::{Hash, Hasher};
use core::marker::PhantomData;
use core::ops::{Index, IndexMut};

/// A typed, generational handle to an entity of type `T` in an [`Arena<T>`].
///
/// `Copy`, `Eq`, `Ord` (by index, then generation) and `Hash` regardless of `T`.
/// `Debug` prints the entity type's short name, index and generation, e.g. `Face#12v1`.
pub struct Id<T> {
    index: u32,
    generation: u32,
    _marker: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    /// Rebuild an id from its raw parts (process-local; for debugging and tests).
    pub fn from_raw_parts(index: u32, generation: u32) -> Self {
        Self {
            index,
            generation,
            _marker: PhantomData,
        }
    }
    /// Slot index.
    #[inline]
    pub fn index(self) -> u32 {
        self.index
    }
    /// Generation of the slot when this id was issued.
    #[inline]
    pub fn generation(self) -> u32 {
        self.generation
    }
}

impl<T> Clone for Id<T> {
    #[inline]
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    #[inline]
    fn eq(&self, o: &Self) -> bool {
        self.index == o.index && self.generation == o.generation
    }
}
impl<T> Eq for Id<T> {}

impl<T> PartialOrd for Id<T> {
    #[inline]
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl<T> Ord for Id<T> {
    #[inline]
    fn cmp(&self, o: &Self) -> Ordering {
        (self.index, self.generation).cmp(&(o.index, o.generation))
    }
}

impl<T> Hash for Id<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.index.hash(state);
        self.generation.hash(state);
    }
}

/// The last path segment of a type name, without generic arguments.
fn short_type_name<T>() -> &'static str {
    let full = core::any::type_name::<T>();
    let base = full.split('<').next().unwrap_or(full);
    base.rsplit("::").next().unwrap_or(base)
}

impl<T> fmt::Debug for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}#{}v{}",
            short_type_name::<T>(),
            self.index,
            self.generation
        )
    }
}

impl<T> fmt::Display for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[derive(Clone, Debug)]
enum Slot<T> {
    Occupied {
        generation: u32,
        value: T,
    },
    Free {
        generation: u32,
        next_free: Option<u32>,
    },
}

/// A generational arena: a `Vec` of slots addressed by [`Id<T>`].
#[derive(Clone, Debug)]
pub struct Arena<T> {
    slots: Vec<Slot<T>>,
    free_head: Option<u32>,
    len: usize,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Arena<T> {
    /// An empty arena.
    pub fn new() -> Self {
        Self {
            slots: Vec::new(),
            free_head: None,
            len: 0,
        }
    }
    /// An empty arena with room for `n` entities.
    pub fn with_capacity(n: usize) -> Self {
        Self {
            slots: Vec::with_capacity(n),
            free_head: None,
            len: 0,
        }
    }
    /// Number of live entities.
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    /// `true` if there are no live entities.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    /// Insert a value and return its id. Reuses the most recently freed slot, if any.
    ///
    /// # Panics
    /// If the arena would exceed `u32::MAX` slots.
    pub fn insert(&mut self, value: T) -> Id<T> {
        self.len += 1;
        if let Some(index) = self.free_head {
            let slot = &mut self.slots[index as usize];
            let (generation, next_free) = match *slot {
                Slot::Free {
                    generation,
                    next_free,
                } => (generation, next_free),
                Slot::Occupied { .. } => unreachable!("free list points at an occupied slot"),
            };
            *slot = Slot::Occupied { generation, value };
            self.free_head = next_free;
            return Id::from_raw_parts(index, generation);
        }
        let index = u32::try_from(self.slots.len()).expect("arena exceeds u32::MAX slots");
        self.slots.push(Slot::Occupied {
            generation: 0,
            value,
        });
        Id::from_raw_parts(index, 0)
    }
    /// `true` if `id` refers to a live entity of this arena.
    pub fn contains(&self, id: Id<T>) -> bool {
        self.get(id).is_some()
    }
    /// The entity, or `None` if the id is stale or out of range.
    pub fn get(&self, id: Id<T>) -> Option<&T> {
        match self.slots.get(id.index as usize) {
            Some(Slot::Occupied { generation, value }) if *generation == id.generation => {
                Some(value)
            }
            _ => None,
        }
    }
    /// Mutable access to the entity, or `None` if the id is stale or out of range.
    pub fn get_mut(&mut self, id: Id<T>) -> Option<&mut T> {
        match self.slots.get_mut(id.index as usize) {
            Some(Slot::Occupied { generation, value }) if *generation == id.generation => {
                Some(value)
            }
            _ => None,
        }
    }
    /// Remove and return the entity. Its slot's generation is bumped so `id` (and any
    /// copy of it) becomes stale. A slot whose generation would overflow is retired and
    /// never reused.
    pub fn remove(&mut self, id: Id<T>) -> Option<T> {
        let idx = id.index as usize;
        match self.slots.get(idx) {
            Some(Slot::Occupied { generation, .. }) if *generation == id.generation => {}
            _ => return None,
        }
        let next_gen = id.generation.checked_add(1);
        let free = Slot::Free {
            generation: next_gen.unwrap_or(u32::MAX),
            next_free: self.free_head,
        };
        let old = core::mem::replace(&mut self.slots[idx], free);
        if next_gen.is_some() {
            self.free_head = Some(id.index);
        } else if let Slot::Free { next_free, .. } = &mut self.slots[idx] {
            *next_free = None; // retired: not on the free list
        }
        self.len -= 1;
        match old {
            Slot::Occupied { value, .. } => Some(value),
            Slot::Free { .. } => unreachable!("checked above"),
        }
    }
    /// Iterate over `(id, &value)` in slot-index order.
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (Id<T>, &T)> + '_ {
        self.slots.iter().enumerate().filter_map(|(i, s)| match s {
            Slot::Occupied { generation, value } => {
                Some((Id::from_raw_parts(i as u32, *generation), value))
            }
            Slot::Free { .. } => None,
        })
    }
    /// Iterate over `(id, &mut value)` in slot-index order.
    pub fn iter_mut(&mut self) -> impl DoubleEndedIterator<Item = (Id<T>, &mut T)> + '_ {
        self.slots
            .iter_mut()
            .enumerate()
            .filter_map(|(i, s)| match s {
                Slot::Occupied { generation, value } => {
                    Some((Id::from_raw_parts(i as u32, *generation), value))
                }
                Slot::Free { .. } => None,
            })
    }
    /// Iterate over the live ids in slot-index order.
    pub fn ids(&self) -> impl DoubleEndedIterator<Item = Id<T>> + '_ {
        self.iter().map(|(id, _)| id)
    }
    /// Iterate over the live values in slot-index order.
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &T> + '_ {
        self.iter().map(|(_, v)| v)
    }
    /// Remove every entity. Generations are bumped so previously issued ids stay stale.
    pub fn clear(&mut self) {
        let ids: Vec<Id<T>> = self.ids().collect();
        for id in ids {
            self.remove(id);
        }
    }
}

impl<T> Index<Id<T>> for Arena<T> {
    type Output = T;
    /// # Panics
    /// If the id is stale or out of range.
    fn index(&self, id: Id<T>) -> &T {
        match self.get(id) {
            Some(v) => v,
            None => panic!("stale or invalid id {id:?}"),
        }
    }
}

impl<T> IndexMut<Id<T>> for Arena<T> {
    /// # Panics
    /// If the id is stale or out of range.
    fn index_mut(&mut self, id: Id<T>) -> &mut T {
        match self.get_mut(id) {
            Some(v) => v,
            None => panic!("stale or invalid id {id:?}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    struct Face(u32);

    #[test]
    fn debug_prints_type_index_generation() {
        let mut a = Arena::new();
        let id = a.insert(Face(1));
        assert_eq!(format!("{id:?}"), "Face#0v0");
        a.remove(id);
        let id2 = a.insert(Face(2));
        assert_eq!(format!("{id2:?}"), "Face#0v1");
    }

    #[test]
    fn stale_ids_are_detected() {
        let mut a = Arena::new();
        let x = a.insert(Face(1));
        assert_eq!(a.remove(x), Some(Face(1)));
        let y = a.insert(Face(2));
        assert_eq!(x.index(), y.index());
        assert!(a.get(x).is_none() && a.remove(x).is_none());
        assert_eq!(a[y], Face(2));
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn iteration_is_in_index_order_and_reuse_is_lifo() {
        let mut a = Arena::new();
        let ids: Vec<_> = (0..5).map(|i| a.insert(Face(i))).collect();
        a.remove(ids[1]);
        a.remove(ids[3]);
        let r = a.insert(Face(10)); // reuses slot 3 (last freed)
        assert_eq!(r.index(), 3);
        let order: Vec<u32> = a.values().map(|f| f.0).collect();
        assert_eq!(order, vec![0, 2, 10, 4]);
    }

    #[test]
    fn ids_are_ordered_and_hashable() {
        use std::collections::BTreeSet;
        let a: Id<Face> = Id::from_raw_parts(2, 0);
        let b: Id<Face> = Id::from_raw_parts(1, 5);
        let s: BTreeSet<_> = [a, b].into_iter().collect();
        assert_eq!(s.into_iter().collect::<Vec<_>>(), vec![b, a]);
    }

    #[test]
    fn exhausted_generation_retires_slot() {
        let mut a = Arena::new();
        let id = a.insert(Face(0));
        // Forge a slot at the maximum generation.
        a.slots[0] = Slot::Occupied {
            generation: u32::MAX,
            value: Face(0),
        };
        let old = Id::from_raw_parts(id.index(), u32::MAX);
        assert!(a.remove(old).is_some());
        let fresh = a.insert(Face(1));
        assert_ne!(fresh.index(), 0, "retired slot must not be reused");
    }
}
