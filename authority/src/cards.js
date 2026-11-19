// Persona cards: several named persona documents per entity, exactly one of them current.
//
// Storage (no schema change): the library lives under the metadata key 'personaCards', one entry per entity:
//   { currentId, cards: { [id]: { id, title, tags?, summary?, persona, createdAt, updatedAt } } }
// `title`, `tags` and `summary` only help the operator pick a card: they are never rendered into a context.
// The persona in force stays where it always was (`entities.persona` / `persona_revision`): that row is the
// only thing a conversation reads, and the current card's content IS that row (its stored copy is only what
// the card held when it last stopped being current). So a release without cards still reads and edits the
// persona in force, and its edit is the current card's content when this release runs again.
//
// Until the library is first written an entity has one card, the default card, holding the persona it
// already had: nothing is rewritten for it and the persona block keeps its bytes.
//
// Subjective memory (her feeling in a digest) carries the id of the card it was written under and is read back
// to that card only; what carries no card id was written before cards existed and belongs to the default card.

export const CARDS_KEY = 'personaCards';
export const DEFAULT_CARD_ID = 'card:default';
export const DEFAULT_CARD_TITLE = '默认卡';
export const MAX_PERSONA_CARDS = 24;
export const CARD_TITLE_CHARS = 40;
export const CARD_TAGS = 6;
export const CARD_TAG_CHARS = 12;
export const CARD_SUMMARY_CHARS = 60;

/** An entity's library before it was ever written. */
export function initialLibrary() {
  return { currentId: DEFAULT_CARD_ID, cards: { [DEFAULT_CARD_ID]: { id: DEFAULT_CARD_ID, title: DEFAULT_CARD_TITLE, persona: null, createdAt: null, updatedAt: null } } };
}

/** Her feeling in a memory entry, for the card now current: '' when it was written under another card. */
export function feelingFor(entry, cardId) {
  return typeof entry.feeling === 'string' && (entry.cardId ?? DEFAULT_CARD_ID) === cardId ? entry.feeling : '';
}
