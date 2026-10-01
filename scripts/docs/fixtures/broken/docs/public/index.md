# Public

An ![internal diagram](../internal/images/diagram.svg) and a [handbook page](../internal/stale.md).

[d]: ../internal/images/diagram.svg

> [q]: ../internal/images/diagram.svg

- [l]: ../internal/images/diagram.svg

- An item

  - a nested one

    [f]: ../internal/images/diagram.svg

<!-- automd:file src=../internal/part.txt -->

Internal text.

<!-- /automd -->

<!-- automd:file
  src="/docs/internal/part.txt"
-->

Internal text.

<!-- /automd -->

> <!-- a comment the quote ends
[v1]: ../internal/images/diagram.svg
-->

- <!-- a comment the list item ends
[v2]: ../internal/images/diagram.svg
-->

Para.

    <!-- indented code, not a comment
[v3]: ../internal/images/diagram.svg
-->

- <!-- a comment an empty line ends in VitePress

  [v4]: ../internal/images/diagram.svg
  -->

![a][a\]b] ![b][multi line] ![c][quoted label] ![d][^x]

[a\]b]: ../internal/images/diagram.svg

[multi
line]: ../internal/images/diagram.svg

> [quoted
> label]: ../internal/images/diagram.svg

[^x]: ../internal/images/diagram.svg

> [!NOTE]
> [q2]: ../internal/images/diagram.svg

Text <!-- a -- b ![dash](../internal/images/diagram.svg) --> end.

Text <!-- ![a](../internal/images/diagram.svg)
<details>
-->
</details>

Text <!-- ![b](../internal/images/diagram.svg)
--> | b |
| - | - |

See ![t](../internal/images/diagram.svg "<!--") -->

Text ` start
| a | b |
| - | - |
| ![s](../internal/images/diagram.svg) | ` |
