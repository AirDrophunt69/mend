# mend

One patch tool for every AI edit format.

Agent harnesses apply edits that models write, and models write them in four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format and text-editor tool calls as JSON. `mend`
reads all four to one specification, finds the lines an edit names even when
the model drifted their whitespace or indentation, and changes every file or
none.

## Usage

```sh
node main.ts [options] [PATCH]
```

Reads the patch from `PATCH`, or from standard input when `PATCH` is `-` or
omitted. Options: `--format=auto|unified|search-replace|v4a|json`,
`--check` (report without writing), `--strict`.

Node 22, standard library only. Deterministic: the same check gives the same
exit code, stdout and files every run.

## License

MIT
