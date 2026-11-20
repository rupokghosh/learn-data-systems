# Learn Data Systems

An interactive companion to [*Designing Data-Intensive Applications*](https://dataintensive.net) by Martin Kleppmann.

Each lesson is one short page with something you can change and watch: split a B-tree page, partition a Raft cluster, crash a two-phase commit coordinator, let a celebrity post and see which timeline design falls over. It covers all 12 chapters of the first edition in 51 lessons.

**This is an unofficial project.** It is not affiliated with or endorsed by Martin Kleppmann or O'Reilly Media. The ideas are the book's; the text, examples, and code here are written from scratch. It is a study aid, not a replacement. Read the book.

## Run it locally

There is no build step and there are no dependencies. The pages use root-absolute paths, so serve the folder from its root:

```bash
python3 -m http.server 4321
```

Then open http://localhost:4321.

## Contributing

Found a bug, a typo, or an explanation that is wrong? Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

The idea of teaching a technical subject through small interactive lessons comes from [learn-inference.com](https://learn-inference.com).

## License

[MIT](LICENSE). The license covers this project's own code and text. It does not cover *Designing Data-Intensive Applications* itself, which belongs to its author and publisher.
