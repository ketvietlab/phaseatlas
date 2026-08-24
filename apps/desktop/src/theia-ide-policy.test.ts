import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedTheiaNavigation, isAllowedTheiaPermission } from "./theia-ide-policy.js";

const PORT = 41_234;

test("theia policy: the IDE may reach its own backend and the webviews it serves", () => {
  assert.equal(isAllowedTheiaNavigation(`http://localhost:${PORT}/`, PORT), true);
  assert.equal(isAllowedTheiaNavigation(`http://abc.webview.localhost:${PORT}/index.html`, PORT), true);

  // Another port is another server, and https://localhost is not this one either.
  assert.equal(isAllowedTheiaNavigation(`http://localhost:${PORT + 1}/`, PORT), false);
  assert.equal(isAllowedTheiaNavigation(`https://localhost:${PORT}/`, PORT), false);
  assert.equal(isAllowedTheiaNavigation("https://example.com/", PORT), false);
  assert.equal(isAllowedTheiaNavigation("not a url", PORT), false);
});

/**
 * Theia is served over HTTP and so runs its browser frontend, whose clipboard
 * service asks `navigator.permissions` for `clipboard-read` and falls back to
 * `navigator.clipboard.readText()`. Denying every permission denied both, which
 * is why paste stopped working while copy kept looking fine.
 */
test("theia policy: the frontend may read the clipboard, and nothing else may", () => {
  const frontend = `http://localhost:${PORT}`;
  assert.equal(isAllowedTheiaPermission("clipboard-read", frontend, PORT), true);
  assert.equal(isAllowedTheiaPermission("clipboard-sanitized-write", frontend, PORT), true);

  // A capability the IDE has no business holding stays denied.
  for (const permission of ["media", "geolocation", "notifications", "openExternal", "pointerLock"]) {
    assert.equal(isAllowedTheiaPermission(permission, frontend, PORT), false, `${permission} must stay denied`);
  }
});

test("theia policy: an extension's webview does not inherit the frontend's clipboard", () => {
  // Webviews are somebody else's code sharing the partition; they may be navigated
  // to, which is not the same as being trusted with what is on the clipboard.
  assert.equal(
    isAllowedTheiaNavigation(`http://abc.webview.localhost:${PORT}/index.html`, PORT),
    true,
    "the webview origin is still reachable",
  );
  assert.equal(
    isAllowedTheiaPermission("clipboard-read", `http://abc.webview.localhost:${PORT}`, PORT),
    false,
    "but it does not get to read the clipboard",
  );
});

test("theia policy: a clipboard request from anywhere else is refused", () => {
  for (const origin of [
    `http://localhost:${PORT + 1}`,
    `https://localhost:${PORT}`,
    "https://example.com",
    "file://",
    "",
    "not a url",
  ]) {
    assert.equal(
      isAllowedTheiaPermission("clipboard-read", origin, PORT),
      false,
      `${origin || "(empty)"} must be refused`,
    );
  }
});
