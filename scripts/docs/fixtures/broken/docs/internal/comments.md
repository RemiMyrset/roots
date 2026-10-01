# Comments

Text <!-- a -- b [[dash-in-comment]] --> end.

Text <!--> [[empty-opener]] and
then -->

Text <!---> [[dash-opener]] and
then -->

Text \<!-- an escaped opener [[escaped-opener]] --> end.

| a | b |
| - | - |
| <!-- c | [[table-cell]] --> |

Text <!-- a
| x | y |
| - | - |
| [[table-row]] | b --> |

Text <!-- a `--` b
[[tick-in-text]] -->

- a
  - b <!-- c
    # Nested heading
    [[nested-heading]] -->

Text `code <!-- a
more` [[after-span]] -->

Text `code
a <!-- b` [[after-continued-span]] -->

## Heading `x
[[after-heading-tick]]` z

***```***
    ```
[[after-span-pair]] ```

- item <!-- a
  --> b
  ```
  code
- next
[[after-item-fence]]

<!-- a -->``
[[after-block-line-ticks]]``

``<!-- c -->`
[[after-glued-ticks]] ```

Text <!-- a
-->```
[[after-closing-ticks]]

<!-- a
-->```
[[after-block-ticks]]

```[[fence-info-comment]] <!-- ` -->

<!-- c | d
| - | - |
| [[table-header]] | e -->
