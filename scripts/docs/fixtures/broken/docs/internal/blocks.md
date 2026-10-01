# Blocks

Text ` a
<br> b ` [[br-continues]] `

Text ` a
b | c ` [[column-count]] `
| - |

Text [a](./stale.md <!-- ` y) -->
[[not-a-title]] ` z

<details>`[[raw-span]]`</details>

<details>
`[[raw-later]]`
</details>

<!-- c --> `[[comment-block-rest]]`

Text <!-- a | ` --> [[pipe-in-comment]] ` b

See ![w](./stale.md "<!--
") [[wrapped-title]] -->

See [c](./stale.md "a
x <!-- b")
[[title-carry]] -->

| a | b |
| - | - |
| `x [[cell-span]] | y` |

- a | b
| - | - |
| `x [[item-table]] | y` |

- a | b
    | - | - |
  | `x [[inner-table]] | y` |

| a |
| - |
`x [[pipeless-row]]
y`

> <!-- [[shallow-head]] |
| - |

> > ```
> [[shallower-quote]]

``` a ` b
` c
[[info-tick]] `

- - -
    `
[[hr-not-item]] `

Setext title
-
    `
[[setext-not-item]] `

- - a `
  b ` [[nested-marker]] `
  c `

1. a `
    > b [[item-quote]]
c `

1. `` [[relative-end]]
    <!-- b `` -->

- a
<!-- b -->
    `
[[block-ends-item]] `

> > a `
b
    <!-- c -->
[[deep-lazy]] `

a
>     `
    ` b `
[[quote-code]] `

<details>
>
`[[quoted-blank-raw]]`

<br>
`[[lone-br]]`

--
    `
` [[dashes-text]] \`

See [w](./missing-wrapped.md "a
b")

See [n](./missing-next.md
"b")

- a
`` c
    <details>
[[para-base]] ``

- a `
>     `
  [[lists-reset]] `

> > a
b
    # c `
[[deep-ends]] `

a |
---
`[[delimiter-row]]
b`

> > x
> > a ` |
> | - |
> > ` [[deep-runs-on]] `

> > a
b `
> c ` [[para-quote]] `
> d `

| a |
| - |
```

```
[[table-end]]

> > a
b
> c `
> > d ` [[para-onward]] `
> > e `

Text
<br>
```

```
[[br-fence]]

x](./stale.md "<!-- ` -->") [[no-label]] `

Text `a
2. b ` [[ordered-two]] `

Text `
-
[[dash-underline]] `

Text
2. <details>
   ```

   ```
   [[ordered-fence]]

- a
b
  ~~~
c
[[lazy-item-fence]]

<details>
```
</details>

[[after-raw-fence]]
