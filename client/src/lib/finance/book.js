// Which of its books the Finance page works in (spec §10: the book switch is remembered). It is remembered per BROWSER, not per
// user: the shell keeps it in storage under one key, fin_book, which every login on this browser shares. A login that does not hold
// the remembered book simply opens on its first (finPickBook), so a shared tablet never shows anyone a book they do not hold.
//
// One rule decides both questions the page asks, and it is finBookOf: an id names a book only while this login still holds
// it. An id is a whole number or its text (the server sends numbers; storage and a URL hand back text). Anything else names
// nothing, a list or an object or a bigint that would print like an id included, so a stale remembered book and a wrong id
// from a page are refused the same way.
//
// Pure ESM, no React, no DOM, no imports: the server tests import this file by relative path and the browser bundles it
// as written.

// The book of `books` that `id` names, or null. It is the very object in `books`, so a page may hold on to it.
export function finBookOf(books, id) {
  if (!Array.isArray(books) || (typeof id !== 'number' && typeof id !== 'string')) return null;
  return books.find(book => String(book.id) === String(id)) ?? null;
}

// The book the page opens on: the one remembered from the last visit (text from storage, or nothing) while this login
// still holds it, otherwise its first. No books at all is null: that login has no Finance grant.
export function finPickBook(books, remembered) {
  if (!Array.isArray(books) || books.length === 0) return null;
  return finBookOf(books, remembered) ?? books[0];
}

// The book the shell is on once /finance/me has been asked for again after a grant changed (ruling R60): the book it is on now, while
// the new answer still lists it (the NEW object, so the page gets the roles the login has now); otherwise the first book of the new
// answer; and null when the login holds none any more, which is the shell's one sentence for a login with no grant. `current` is the
// book on screen, or null. Without this a book granted meanwhile that sorts first would pull a login off the book it is working in.
export function finBookAfterReload(books, current) {
  return finPickBook(books, current == null ? null : current.id);
}
