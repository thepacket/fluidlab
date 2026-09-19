# Security

FluidLab is a static site. It has no server side, no accounts and no analytics: a rig lives in the browser's local
storage, in a project file you save yourself, or inside the `#rig=` part of a share link, which browsers do not send
to the server.

What is worth reporting:

- a share link or project file that can run script, or otherwise act outside the bench, when someone opens it;
- a dependency with a known vulnerability that reaches the built site;
- anything in the deployment files (`Dockerfile`, `deploy/nginx.conf`) that weakens the served site.

Please report these privately through GitHub — **Security → Report a vulnerability** on
<https://github.com/thepacket/fluidlab> — rather than in a public issue. Expect an acknowledgement within a week.
Only the latest commit on `main` is supported.

Wrong hydraulics are bugs, not vulnerabilities: open an ordinary issue, with the rig attached.
