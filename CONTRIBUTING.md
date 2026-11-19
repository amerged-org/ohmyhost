# Contributing

ohmyho.st's original platform source is source available under Elastic License 2.0. It is not OSI-approved open source. The client workspaces and customer Skills designated in [the licensing manifest](licenses/manifest.json) use Apache License 2.0. Third-party code keeps its existing licenses and notices, including the PostgreSQL bridge's upstream attribution.

Read [LICENSE, Appendix I — Contributing](LICENSE#L96) before intentionally submitting a pull request or a patch through a private security advisory. That submission grants Amerged B.V. the rights described there; you keep ownership. There is no separate agreement service, signature or contribution checkbox. The appendix applies to intentional submissions after it becomes available, not retroactively. Ordinary issue comments, discussions, feedback and vulnerability reports without an intentionally submitted patch do not trigger it.

Submit only material you have authority to contribute, including any permission needed from your employer. Identify third-party material and retain its license and attribution. Never copy restricted platform code into an Apache client or change its package label to obtain an Apache distribution. The client packaging gate checks actual copied, generated and bundled source, declarations and source maps against the manifest.

Describe the problem, the resulting behavior and relevant verification in your pull request. Follow [development rules](docs/development.md), preserve other contributors' changes and run the checks appropriate to your change. For license changes, run `pnpm licenses:check` and `pnpm licenses:test`. Publication and deployments require their separate release approval.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Keep credentials and customer data out of issues, patches, logs and reproduction artifacts.
