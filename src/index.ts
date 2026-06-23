import "dotenv/config";
import {
	Client,
	Events,
	GatewayIntentBits,
	Message,
	Partials,
} from "discord.js";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		...(process.env.DISCORD_MESSAGE_CONTENT_INTENT === "true"
			? [GatewayIntentBits.MessageContent]
			: []),
	],
	partials: [Partials.Channel, Partials.Message],
});

const DISCORD_TOKEN = requiredEnv("DISCORD_TOKEN");
const XAI_API_KEY = requiredEnv("XAI_API_KEY");

const XAI_MODEL = process.env.XAI_MODEL || "grok-4.3";
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 12);

const SYSTEM_PROMPT = `
You are Grok, a helpful AI assistant running inside Discord.

Identity:
- You are Grok, created by xAI.
- You are speaking through a community Discord bot by Meta Games LLC, not the official Grok app.
- Current date: ${new Date().toLocaleDateString("en-US", {
	timeZone: "America/Los_Angeles",
	weekday: "long",
	year: "numeric",
	month: "long",
	day: "numeric",
})}.
- Current time zone context: America/Los_Angeles.

Capabilities:
- You can read the current mentioned message.
- You may be given recent Discord channel history for context.
- You may be given image attachment URLs and should analyze them when relevant.
- You may use web search when fresh or current information is needed.

Behavior:
- Be direct, useful, and Discord-friendly.
- Keep replies concise unless the user asks for detail.
- Do not pretend you saw messages, images, files, or links unless they were provided in the prompt.
- If context is missing, say what is missing.
- For code, give complete fixed snippets.
- Ensure your responses are properly formatted for Discord, using code blocks and markdown when appropriate. Discord does not support HTML or tables, so avoid them.
- If you are unsure about something, say so.
`.trim();

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

function stripBotMention(content: string, botId: string): string {
	return content
		.replace(new RegExp(`<@!?${botId}>`, "g"), "")
		.trim();
}

function hasMeaningfulText(input: string): boolean {
	return /[\p{L}\p{N}]/u.test(input);
}

function isImageAttachment(url: string, contentType?: string | null): boolean {
	if (contentType?.startsWith("image/")) return true;
	return /\.(png|jpe?g|webp|gif)$/i.test(url.split("?")[0] || "");
}

async function getRecentHistory(message: Message): Promise<string> {
	if (!message.channel.isTextBased()) return "";

	const fetched = await message.channel.messages.fetch({
		limit: MAX_HISTORY_MESSAGES + 1,
	});

	const messages = [...fetched.values()]
		.filter((m) => m.id !== message.id)
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.slice(-MAX_HISTORY_MESSAGES);

	return messages
		.map((m) => {
			const name = m.member?.displayName || m.author.username;
			const text = m.content?.trim() || "[no text]";
			const attachments = [...m.attachments.values()]
				.map((a) => a.url)
				.join(", ");

			return `${name}: ${text}${attachments ? `\nAttachments: ${attachments}` : ""}`;
		})
		.join("\n\n");
}

function buildUserContent(prompt: string, history: string, imageUrls: string[]) {
	const text = [
		history ? `Recent Discord context:\n${history}` : "",
		`Current user message:\n${prompt}`,
		imageUrls.length
			? `Attached image URLs:\n${imageUrls.join("\n")}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");

	return [
		{ type: "input_text", text },
		...imageUrls.map((url) => ({
			type: "input_image",
			image_url: url,
		})),
	];
}

function extractResponseText(data: any): string {
	if (typeof data.output_text === "string" && data.output_text.trim()) {
		return data.output_text.trim();
	}

	const parts: string[] = [];

	for (const item of data.output ?? []) {
		for (const content of item.content ?? []) {
			if (content.type === "output_text" && content.text) {
				parts.push(content.text);
			}
		}
	}

	return parts.join("\n").trim() || "Sorry, I wasn't able to generate a response.";
}

async function askGrok(prompt: string, history: string, imageUrls: string[]): Promise<string> {
	const response = await fetch("https://api.x.ai/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${XAI_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: XAI_MODEL,
			input: [
				{
					role: "system",
					content: SYSTEM_PROMPT,
				},
				{
					role: "user",
					content: buildUserContent(prompt, history, imageUrls),
				},
			],
			tools: [
				{
					type: "web_search",
					filters: {
						enable_image_understanding: true,
						enable_image_search: true,
					},
				},
			],
			temperature: 0.7,
			max_output_tokens: 1200,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`xAI API Error: ${response.status} ${response.statusText}\n${body}`);
	}

	return extractResponseText(await response.json());
}

async function sendLongReply(message: Message, text: string): Promise<void> {
	const chunks = text.match(/[\s\S]{1,1900}/g) ?? [text];

	await message.reply(chunks[0]);

	for (const chunk of chunks.slice(1)) {
		if (message.channel.isTextBased() && !message.channel.isDMBased()) {
			await message.channel.send(chunk);
		}
	}
}

client.once(Events.ClientReady, () => {
	console.log(`Logged in as ${client.user?.tag}`);
	console.log(`Using xAI model: ${XAI_MODEL}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
	if (message.author.bot || !client.user) return;

	const mentioned = message.mentions.users.has(client.user.id);
	const isReplyToBot =
		message.reference?.messageId &&
		(await message.channel.messages
			.fetch(message.reference.messageId)
			.then((m) => m.author.id === client.user!.id)
			.catch(() => false));

	if (!mentioned && !isReplyToBot) return;

	const prompt = stripBotMention(message.content, client.user.id);

	const imageUrls = [...message.attachments.values()]
		.filter((a) => isImageAttachment(a.url, a.contentType))
		.map((a) => a.url);

	if (!hasMeaningfulText(prompt) && imageUrls.length === 0) {
		await message.reply("Mention me with a question or attach an image.");
		return;
	}

	try {
		if (message.channel.isTextBased() && !message.channel.isDMBased()) {
			await message.channel.sendTyping();
		}

		const history = await getRecentHistory(message);
		const response = await askGrok(prompt || "Please analyze the attached image.", history, imageUrls);

		await sendLongReply(message, response);
	} catch (error) {
		console.error(error);
		await message.reply("Sorry, I hit an error while contacting Grok. Check the console for details.");
	}
});

client.login(DISCORD_TOKEN);