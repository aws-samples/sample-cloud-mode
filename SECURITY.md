# Security Policy

## Status of this project

This repository is a **proof of concept / sample code**. It is **not**
production-ready, it is not a supported AWS service or offering, and it is
provided "AS IS" without warranty (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
The isolation model it demonstrates is illustrative and has **not** been
adversarially tested. Before deploying or adapting it, read
[README.md → Security considerations](README.md#security-considerations) and
[docs/agent-isolation.md](docs/agent-isolation.md), and run your own security review.

## Reporting a vulnerability

If you discover a potential security issue in this project, please notify AWS
Security via the
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or email aws-security@amazon.com. **Please do not create a public GitHub issue**
for a security report.

## Things that are by design, not vulnerabilities

The following are documented properties of this sample. Reports about them are welcome as design feedback, but they are already
known:

- An AWS `bedrock-agentcore:InvokeAgentRuntime` permission on the deployed
  runtime is transitively GitHub **write** access to every repository the Cloud
  Mode GitHub App is installed on.
- The agent is assumed to be attacker-influenceable: story text, repository
  contents and CI output all reach the model, and prompt injection is assumed to
  succeed.
- `deliveryMode: "direct-merge"` lands model-authored commits on a default
  branch with no human review of the diff. It is opt-in, not the default.
- The in-container uid/env split around untrusted execution is defence in depth,
  not a hardened trust boundary (see README § Security considerations).
