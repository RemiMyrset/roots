# Clean fixture

Links resolve: [decisions](./docs/internal/decisions/index.md) and
[specs](./docs/internal/specs/index.md).

> [!NOTE]
> A GitHub-style alert renders everywhere.

Fenced code is exempt from every rule:

```text
[[wikilink]] :rocket: <div>not html</div> {{ not vue }}
```

Inline code too: `[[brackets]]` and `<tag>`.

> [!TIP]
> A fence inside a quote is code:
>
> ```text
> [[wikilink]] <div>quoted</div>
> ```

<!--
A multi-line comment holds [[wikilinks]] and <div>tags</div>
without being scanned.
-->

A backticked `<!--` opens no comment, so this [link](./AGENTS.md) is checked.

Setext heading
---

A [titled link](./AGENTS.md "Agent rulebook"), an [angle-bracket target](<./AGENTS.md>),
a [reference][ref], an [anchor](./AGENTS.md#agent-rulebook), and a [self link](#clean-fixture).

[ref]: ./docs/internal/specs/index.md

~~~text
[[wikilink]] in a tilde fence
~~~

````text
```text
a three-backtick fence inside a four-backtick fence
```
````
