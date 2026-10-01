---
title: frontmatter is banned
---
# Broken fixture

A [[wikilink]] and an [absolute](/docs/x.md) link, a :rocket: shortcode, and a <div>tag</div>.

A {{ vue }} interpolation.

A [broken](./missing.md) relative link.

:::tip
A VitePress container.
:::

<<< ./snippet.ts

## Broken fixture

<!-- @include: ./part.md -->

## The `code` heading

A [root](/) link and an [absolute reference][abs].

[abs]: /abs.md

A [broken anchor](./AGENTS.md#nope).

<!-- eslint-disable-next-line markdown/no-multiple-h1 -- a second H1 is what this fixture exercises -->
# Second H1

> [!tip]
> A lowercase callout.

## Title ###

## Title

A `{{ vue }}` in inline code is still evaluated.

> [!NOTE] Custom title
> A titled alert.

> [!NOTE]-
> A folded alert.

A split <img
  src="x.png"> tag.

An [angle-bracket absolute](</abs.md>) link.

A [space-padded absolute]( /abs.md) link.

A [raw space](./My Doc.md) link.

A [wrong-case](./agents.md) link.

A [newline-padded absolute](
/abs.md) link.

[padded]:
  /abs.md

A stray ` backtick, then a split <img
  src="x.png"> tag.

> [qabs]: /abs.md
> [qbr]: ./missing.md

- [lbr]: ./missing.md

> [qnext]:
> ./missing.md

- [lnext]:
  ./missing.md
