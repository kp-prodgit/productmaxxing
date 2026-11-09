export type Fetch = typeof fetch;

// Slack channels are read through the PM's Slack connector in Claude from 0.21.0 (INPUT-1), never with a token here.
// What's left is the optional digest DM, which needs `chat:write`.

/** Sends the PM their own digest as a DM (DIG-2, optional). Needs `chat:write`. */
export async function sendSlackDm(o: { token: string; userId: string; text: string; fetch?: Fetch }): Promise<void> {
  const f = o.fetch ?? fetch;
  const res = await f("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: o.userId, text: o.text, unfurl_links: false }),
  });
  const body: any = await res.json();
  if (!body.ok) throw new Error(`Slack chat.postMessage: ${body.error}`);
}
