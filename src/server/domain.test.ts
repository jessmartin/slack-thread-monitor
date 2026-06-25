import { assert, describe, it } from "@effect/vitest"
import { extractReferences, parseCardStatus } from "./domain"

describe("domain", () => {
  it("extracts GitHub and Linear references", () => {
    const refs = extractReferences(
      "See ABC-123, https://github.com/jessmartin/slack-thread-monitor/issues/7 and openai/codex#42",
      { linearWorkspaceUrl: "https://linear.app/acme" }
    )

    assert.deepStrictEqual(
      refs.map((ref) => `${ref.provider}:${ref.displayKey}:${ref.url}`),
      [
        "linear:ABC-123:https://linear.app/acme/issue/ABC-123",
        "github:jessmartin/slack-thread-monitor#7:https://github.com/jessmartin/slack-thread-monitor/issues/7",
        "github:openai/codex#42:https://github.com/openai/codex/issues/42"
      ]
    )
  })

  it("parses unknown statuses as new message", () => {
    assert.strictEqual(parseCardStatus("awaiting_reply"), "awaiting_reply")
    assert.strictEqual(parseCardStatus("resolved"), "resolved")
    assert.strictEqual(parseCardStatus("unknown"), "new_message")
  })
})
