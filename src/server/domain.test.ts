import { assert, describe, it } from "@effect/vitest"
import { buildSlackNativeMessageUrl, normalizeSlackMessageTs, readableSlackActorLabel } from "../shared/slack"
import { buildExcerpt, extractReferences, parseCardStatus, shouldTrackMessage, type SlackMessageProjectionInput } from "./domain"

describe("domain", () => {
  const message = (overrides: Partial<SlackMessageProjectionInput>): SlackMessageProjectionInput => ({
    teamId: "T1",
    eventId: "E1",
    eventTs: "1.0",
    channelId: "C1",
    channelName: "general",
    messageTs: "1.0",
    rootThreadTs: "1.0",
    userId: "U2",
    parentUserId: null,
    userName: "Person",
    userImageUrl: null,
    text: "hello",
    rawJson: "{}",
    mySlackUserId: "U1",
    slackPermalink: null,
    linearWorkspaceUrl: null,
    ...overrides
  })

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

  it("deduplicates Slack-formatted Linear links", () => {
    const refs = extractReferences(
      "Check this out <https://linear.app/elicit-research/issue/ELI-16615/create-daily-usage-chart|ELI-16615: Create Daily Usage Chart>",
      { linearWorkspaceUrl: "https://linear.app/elicit-research" }
    )

    assert.deepStrictEqual(
      refs.map((ref) => `${ref.provider}:${ref.displayKey}:${ref.url}`),
      [
        "linear:ELI-16615:https://linear.app/elicit-research/issue/ELI-16615/create-daily-usage-chart"
      ]
    )
  })

  it("renders Slack link markup as readable excerpt text", () => {
    assert.strictEqual(
      buildExcerpt(
        "Thanks for sharing! That's <https://linear.app/elicit-research/issue/ELI-16615/create-daily-usage-chart|ELI-16615: Create Daily Usage Chart>"
      ),
      "Thanks for sharing! That's ELI-16615: Create Daily Usage Chart"
    )
  })

  it("parses unknown statuses as new message", () => {
    assert.strictEqual(parseCardStatus("awaiting_reply"), "awaiting_reply")
    assert.strictEqual(parseCardStatus("resolved"), "resolved")
    assert.strictEqual(parseCardStatus("archived"), "archived")
    assert.strictEqual(parseCardStatus("unknown"), "new_message")
  })

  it("suppresses raw Slack actor ids from display labels", () => {
    assert.strictEqual(readableSlackActorLabel("B0AH21M1BQ9"), null)
    assert.strictEqual(readableSlackActorLabel("U0B81LBA5C5"), null)
    assert.strictEqual(readableSlackActorLabel("Coding Agent"), "Coding Agent")
  })

  it("builds native Slack message links with message timestamps", () => {
    assert.strictEqual(normalizeSlackMessageTs("p1719234567890123"), "1719234567.890123")
    assert.strictEqual(normalizeSlackMessageTs("1719234567.890123"), "1719234567.890123")
    assert.strictEqual(
      buildSlackNativeMessageUrl("T123ABC456", "C123ABC456", "p1719234567890123"),
      "slack://channel?team=T123ABC456&id=C123ABC456&message=1719234567.890123"
    )
  })

  it("tracks threads rooted in my Slack messages", () => {
    assert.strictEqual(shouldTrackMessage(message({ userId: "U1" }), false), true)
    assert.strictEqual(shouldTrackMessage(message({ parentUserId: "U1" }), false), true)
    assert.strictEqual(shouldTrackMessage(message({ text: "cc <@U1>" }), false), true)
    assert.strictEqual(shouldTrackMessage(message({ userId: "U2", parentUserId: "U3" }), false), false)
  })
})
