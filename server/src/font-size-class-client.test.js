// Does a class string name a font size? — the predicate ProductIdentity leans on.
//
// THE SENTENCE these tests hold it to:
//
//   `compact` supplies a default size and must stand aside the moment the caller
//   names one — and must NOT stand aside for a `text-*` utility that sets some
//   other property, or the name is left with no size at all.
//
// Both directions are load-bearing and both fail SILENTLY. A false negative puts
// the old bug back: seven screens asked for 13px and rendered 12px for months
// because `text-xs` is emitted after arbitrary sizes and nobody can see one
// pixel. A false positive is worse and just as quiet — `text-slate-800` read as
// a size would strip the default and drop the name to the inherited size.
//
// These live in server/src because client/src/*.jsx cannot be `node --test`'d;
// the predicate was put in client/src/lib for exactly this reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaresFontSize } from '../../client/src/lib/fontSizeClass.js';

test('the named scale counts, at every step', () => {
  for (const c of ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl',
                   'text-2xl', 'text-5xl', 'text-9xl']) {
    assert.equal(declaresFontSize(c), true, c);
  }
});

test('the sizes the real call sites pass', () => {
  // Every nameClassName in the client that carries a size, verbatim.
  for (const c of ['text-[13px] leading-[17px]',        // Gang, Section, SortPaste
                   'text-[13px] text-slate-800',        // Gang, Merge
                   'text-[20px] leading-tight',         // JobCardSheet header
                   'text-[11.5px] font-bold text-slate-700', // PrintPlanning line-up
                   'text-[12.5px] font-extrabold leading-4 tracking-tight text-slate-900',
                   'text-[14px] leading-snug',
                   'text-sm text-brand-800',
                   'text-lg font-extrabold tracking-tight text-slate-900']) {
    assert.equal(declaresFontSize(c), true, c);
  }
});

test('a size still counts when it is marked important', () => {
  // The interim fix wrote these by hand; the predicate must not regress if one
  // is left behind or written again out of habit.
  assert.equal(declaresFontSize('!text-[13px] leading-[17px]'), true);
  assert.equal(declaresFontSize('!text-xl'), true);
});

test('other units, and a calc, are sizes too', () => {
  for (const c of ['text-[1.5rem]', 'text-[2em]', 'text-[14pt]', 'text-[3vw]',
                   'text-[clamp(12px,2vw,18px)]', 'text-[calc(1rem+2px)]']) {
    assert.equal(declaresFontSize(c), true, c);
  }
});

test('an explicit type hint settles it either way', () => {
  assert.equal(declaresFontSize('text-[length:var(--x)]'), true);
  assert.equal(declaresFontSize('text-[color:var(--x)]'), false);
});

test('COLOURS ARE NOT SIZES — the false positive that would blank the size', () => {
  for (const c of ['text-slate-800', 'text-brand-600', 'text-white',
                   'text-[#007AFF]', 'text-[rgb(10,132,255)]', 'text-[hsl(0_0%_0%)]',
                   'text-[var(--ink)]', 'text-slate-800/70']) {
    assert.equal(declaresFontSize(c), false, c);
  }
});

test('alignment, wrapping and truncation are not sizes', () => {
  for (const c of ['text-left', 'text-center', 'text-right', 'text-justify',
                   'text-wrap', 'text-nowrap', 'text-balance', 'text-pretty',
                   'text-ellipsis', 'text-clip']) {
    assert.equal(declaresFontSize(c), false, c);
  }
});

test('a variant-prefixed size does NOT displace the base default', () => {
  // It applies inside its own media/state rule and already outranks the default
  // there; the base breakpoint still needs a size underneath it.
  for (const c of ['lg:text-xl', 'hover:text-lg', 'md:text-[13px]', 'print:text-sm',
                   'group-hover:text-2xl', 'ph:text-xs']) {
    assert.equal(declaresFontSize(c), false, c);
  }
});

test('the size/line-height shorthand is read by its size half', () => {
  assert.equal(declaresFontSize('text-lg/7'), true);
  assert.equal(declaresFontSize('text-[13px]/[17px]'), true);
});

test('a class that merely looks prefix-shaped is not a size', () => {
  for (const c of ['context-xs', 'mytext-lg', 'text', 'texture-lg']) {
    assert.equal(declaresFontSize(c), false, c);
  }
});

test('empty, absent and non-string inputs are simply not sizes', () => {
  // nameClassName defaults to '' and callers pass a ternary that can yield ''.
  for (const v of ['', '   ', undefined, null, 0, {}, ['text-lg']]) {
    assert.equal(declaresFontSize(v), false, String(v));
  }
});

test('the size is found wherever it sits in the string', () => {
  assert.equal(declaresFontSize('font-bold text-slate-700 text-[11.5px]'), true);
  assert.equal(declaresFontSize('  leading-tight   text-[20px]  '), true);
});
