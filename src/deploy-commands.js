import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, ChannelType } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Health check"),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Admin: bot sends a message to this channel")
    .addStringOption(o =>
      o.setName("text").setDescription("Text to send").setRequired(true)
    ),

  // FS25 Dashboard
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("FS25 dashboard")
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription("Create or rebind the FS25 dashboard panels")
        .addChannelOption(o =>
          o.setName("polja_kanal")
            .setDescription("Kanal za panel POLJA")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false) // IMPORTANT: allow fallback if command cache is old
        )
        .addChannelOption(o =>
          o.setName("zadaci_kanal")
            .setDescription("Kanal za panel ZADACI")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false) // IMPORTANT: allow fallback if command cache is old
        )
    )
    .addSubcommand(s =>
      s.setName("reset")
        .setDescription("Reset stored dashboard message IDs (use if messages were deleted)")
    ),

  new SlashCommandBuilder()
    .setName("field")
    .setDescription("Field management")
    .addSubcommand(s =>
      s.setName("add")
        .setDescription("Add a field")
        .addIntegerOption(o => o.setName("broj").setDescription("Broj polja").setRequired(true))
        .addNumberOption(o => o.setName("ha").setDescription("Površina (ha)").setRequired(true))
    )
    .addSubcommand(s =>
      s.setName("del")
        .setDescription("Delete a field")
        .addIntegerOption(o => o.setName("broj").setDescription("Broj polja").setRequired(true))
    )
    .addSubcommand(s =>
      s.setName("merge")
        .setDescription("Merge fields into a single group (SPOJENO)")
        .addStringOption(o => o.setName("brojevi").setDescription("Npr: 7,8,11").setRequired(true))
    )
    .addSubcommand(s =>
      s.setName("unmerge")
        .setDescription("Remove a field from its merge group")
        .addIntegerOption(o => o.setName("broj").setDescription("Broj polja").setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName("crop")
    .setDescription("Crop list (za sjetvu)")
    .addSubcommand(s => s.setName("list").setDescription("List crops"))
    .addSubcommand(s =>
      s.setName("add")
        .setDescription("Add crop")
        .addStringOption(o => o.setName("naziv").setDescription("Naziv usjeva").setRequired(true))
    )
    .addSubcommand(s =>
      s.setName("del")
        .setDescription("Delete crop")
        .addStringOption(o => o.setName("naziv").setDescription("Naziv usjeva").setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName("provjera")
    .setDescription("Posalji provjeru aktivnosti korisniku putem DM-a")
    .addUserOption(o =>
      o.setName("user").setDescription("Korisnik kojem saljes provjeru").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("server")
    .setDescription("Server setup i upravljanje")
    .addSubcommand(s =>
      s.setName("setup")
        .setDescription("Kreiraj/ažuriraj sve kanale, role i permisije na serveru")
    )
    .addSubcommand(s =>
      s.setName("roles")
        .setDescription("Ručno pokreni provjeru nagradnih rola po vremenu igranja")
    )
    .addSubcommand(s =>
      s.setName("farmassign")
        .setDescription("Ručno dodijeli igrača farmi")
        .addUserOption(o => o.setName("user").setDescription("Discord korisnik").setRequired(true))
        .addStringOption(o => o.setName("farm").setDescription("Farm ID (npr. 1, 2, 3...)").setRequired(true))
    ),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

// Deploy to main guild
const mainGuildId = process.env.GUILD_ID;
if (mainGuildId) {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, mainGuildId),
    { body: commands }
  );
  console.log(`Slash commands deployed to main guild (${mainGuildId}).`);
}

// Deploy to test guild if configured
const testGuildId = process.env.TEST_GUILD_ID;
if (testGuildId && testGuildId !== mainGuildId) {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, testGuildId),
    { body: commands }
  );
  console.log(`Slash commands deployed to test guild (${testGuildId}).`);
}

