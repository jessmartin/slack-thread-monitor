import { assert, describe, it } from "@effect/vitest"
import { buildSlackNativeMessageUrl, extractSlackMentionIds, normalizeSlackMessageTs, readableSlackActorLabel, renderSlackEmojiAliases, renderSlackPlainText } from "../shared/slack"
import { buildExcerpt, extractReferences, parseCardStatus, shouldTrackThread, type SlackMessageProjectionInput } from "./domain"

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

  it("renders Slack user and subteam mentions from labels with ID fallbacks", () => {
    assert.strictEqual(
      buildExcerpt("<@U0852CJ7Q2U> it has me half wanting to risk it all"),
      "@U0852CJ7Q2U it has me half wanting to risk it all"
    )
    assert.strictEqual(renderSlackPlainText("<@U0852CJ7Q2U|Jess> please review"), "@Jess please review")
    assert.strictEqual(
      renderSlackPlainText("<@U0852CJ7Q2U> <!subteam^S07Q6QNBALX> please review", {
        users: { U0852CJ7Q2U: "Baskerville" },
        subteams: { S07Q6QNBALX: "eng" }
      }),
      "@Baskerville @eng please review"
    )
    assert.strictEqual(renderSlackPlainText("<!subteam^S07Q6QNBALX> please review"), "@S07Q6QNBALX please review")
    assert.deepStrictEqual(extractSlackMentionIds("<@U0852CJ7Q2U> <!subteam^S07Q6QNBALX>"), {
      userIds: ["U0852CJ7Q2U"],
      subteamIds: ["S07Q6QNBALX"]
    })
  })

  it("renders standard Slack emoji aliases and preserves unknown custom emoji aliases", () => {
    assert.strictEqual(
      renderSlackEmojiAliases("The line annotated the video for me? :exploding_head: :thumbsup: :custom-elicit:"),
      "The line annotated the video for me? 🤯 👍 :custom-elicit:"
    )
    assert.strictEqual(buildExcerpt("Looks good :white_check_mark:"), "Looks good ✅")
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

  it("tracks only real threads where my Slack user authored the root or a reply", () => {
    assert.strictEqual(shouldTrackThread([
      message({ userId: "U1" })
    ]), false)

    assert.strictEqual(shouldTrackThread([
      message({ userId: "U1" }),
      message({ eventId: "E2", eventTs: "2.0", messageTs: "2.0", rootThreadTs: "1.0", userId: "U2" })
    ]), true)

    assert.strictEqual(shouldTrackThread([
      message({ userId: "U2" }),
      message({ eventId: "E2", eventTs: "2.0", messageTs: "2.0", rootThreadTs: "1.0", userId: "U1" })
    ]), true)

    assert.strictEqual(shouldTrackThread([
      message({ userId: "U2" }),
      message({ eventId: "E2", eventTs: "2.0", messageTs: "2.0", rootThreadTs: "1.0", userId: "U3" })
    ]), false)

    assert.strictEqual(shouldTrackThread([
      message({ userId: "U2", text: "cc <@U1>" }),
      message({ eventId: "E2", eventTs: "2.0", messageTs: "2.0", rootThreadTs: "1.0", userId: "U3" })
    ]), false)
  })
})
