import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [appSource, navigationSource] = await Promise.all([
  readFile("src/App.tsx", "utf8"),
  readFile("src/components/Navigation.tsx", "utf8"),
]);

test("the project hover action creates a conversation in its exact project", () => {
  assert.match(appSource, /const newConversationInProject = useCallback\(\(projectId: string\) => \{\s*createConversation\(\s*projectId,/s);
  assert.match(appSource, /onNewConversationForProject=\{newConversationInProject\}/);
  assert.match(navigationSource, /onClick=\{\(\) => onNewConversationForProject\(section\.project\.id\)\}/);
});

test("the project hover action remains named and keyboard accessible", () => {
  assert.match(navigationSource, /className="project-new-conversation"/);
  assert.match(navigationSource, /aria-label=\{t\("nav\.newConversationInProject", \{ name: section\.project\.name \}\)\}/);
  assert.match(navigationSource, /"nav\.newConversationInProject": \["Nouvelle conversation dans \{name\}", "New conversation in \{name\}"\]/);
});
