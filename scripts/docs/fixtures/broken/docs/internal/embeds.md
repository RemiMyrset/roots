# Embeds

<!--
  @include: ./part.txt
-->

```md
<!-- @include: ./part.txt -->
```

An include written in inline code, `<!-- @include: ./part.txt -->`, is expanded too.

- <<< ../../x

1. <<< ./part.txt

- > <<< ./part.txt

> - <<< ./part.txt

> <!-- a comment the quote ends
<<< ./part.txt
-->

- <!-- a comment the list item ends
<<< ./part.txt
-->

Para.

    <!-- indented code, not a comment
<<< ./part.txt
-->

- <!-- a comment an empty line ends in VitePress

  <<< ./part.txt
  -->

- >  <<< ./part.txt

1. >   <<< ./part.txt

Para.

	<!-- tab-indented code
<<< ./part.txt
-->

- item

	<!-- a tab-indented comment the list item ends
<<< ./part.txt
-->
