import "dotenv/config";
import {
	Client,
	GatewayIntentBits,
	Message,
} from "discord.js";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
	],
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const XAI_API_KEY = process.env.XAI_API_KEY!;
const SYSTEM_PROMPT =
	"You are Grok, a helpful AI assistant operating through Discord. " +
	"Important scope rules: respond only to the text in the current message that directly mentioned you. " +
	"Ignore Discord reactions, emoji-only signals, stickers, attachments, embeds, system events, and other users' messages unless they are explicitly quoted in the current message. " +
	"Do not assume additional channel context beyond the provided prompt. " +
	"If a user asks about anything outside this scope, clearly tell them you can only see text in the message where they mentioned you.";

function hasMeaningfulText(input: string): boolean {
	// Require at least one letter or number to avoid treating emoji-only mentions as prompts.
	return /[\p{L}\p{N}]/u.test(input);
}

async function askGrok(prompt: string): Promise<string> {
	const response = await fetch(
		"https://api.x.ai/v1/chat/completions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${XAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "grok-build-0.1",
				messages: [
					{
						role: "system",
						content: SYSTEM_PROMPT,
					},
					{
						role: "user",
						content: prompt,
					},
				],
				temperature: 0.7,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(
			`xAI API Error: ${response.status} ${response.statusText}`,
		);
	}

	const data: any = await response.json();

	return (
		data.choices?.[0]?.message?.content ??
		"Sorry, I wasn't able to generate a response."
	);
}

client.once("ready", () => {
	console.log(`Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message: Message) => {
	if (message.author.bot) return;
	if (!client.user) return;

	const mentioned = message.mentions.users.has(client.user.id);

	if (!mentioned) return;

	const prompt = message.content
		.replace(`<@${client.user.id}>`, "")
		.replace(`<@!${client.user.id}>`, "")
		.trim();

	if (!prompt || !hasMeaningfulText(prompt)) {
		await message.reply(
			`${message.author}, I can only see text in the message where you mention me. Please ask a text question in that mention.`,
		);
		return;
	}

	try {
		if (message.channel.isTextBased() && !message.channel.isDMBased()) {
			await message.channel.sendTyping();
		}

		const response = await askGrok(prompt);

		if (response.length <= 2000) {
			await message.reply(response);
		} else {
			for (let i = 0; i < response.length; i += 1900) {
				if (message.channel.isTextBased() && !message.channel.isDMBased()) {
					await message.channel.send(
						response.substring(i, i + 1900),
					);
				}
			}
		}
	} catch (error) {
		console.error(error);

		await message.reply(
			"Sorry, I encountered an error while contacting Grok.",
		);
	}
});

console.log("Token loaded:", process.env.DISCORD_TOKEN?.substring(0, 10));
client.login(DISCORD_TOKEN);