import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
} from 'discord.js';
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import playdl from 'play-dl';
import { config } from 'dotenv';

config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN e CLIENT_ID precisam estar definidos no .env');
  process.exit(1);
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca uma música do YouTube no canal de voz')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('URL do YouTube ou termo de busca')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a reprodução e desconecta do canal de voz'),
] as const;

// ─── Audio player ─────────────────────────────────────────────────────────────

const player = createAudioPlayer();

player.on('error', error => {
  console.error('Erro no player de áudio:', error.message);
});

// ─── Bot ──────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Pronto! Logado como ${readyClient.user.tag}`);

  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: commands.map(c => c.toJSON()),
  });
  console.log('Slash commands registrados.');
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const { commandName } = interaction;

  // ── /play ──────────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: 'Você precisa estar em um canal de voz para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    // Resolve URL: se for URL do YouTube usa diretamente, senão busca
    let videoUrl: string;
    let videoTitle: string;

    const validation = playdl.yt_validate(query);

    if (validation === 'video') {
      const info = await playdl.video_info(query);
      videoUrl = query;
      videoTitle = info.video_details.title ?? query;
    } else {
      const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });

      if (!results.length) {
        await interaction.editReply('Nenhum resultado encontrado para essa busca.');
        return;
      }

      videoUrl = results[0].url;
      videoTitle = results[0].title ?? query;
    }

    // Conecta ao canal de voz (ou reutiliza conexão existente)
    let connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      } catch {
        connection.destroy();
        await interaction.editReply('Não foi possível conectar ao canal de voz.');
        return;
      }
    }

    // Obtém stream de áudio do YouTube
    const ytStream = await playdl.stream(videoUrl);
    const resource = createAudioResource(ytStream.stream, {
      inputType: ytStream.type,
    });

    player.play(resource);
    connection.subscribe(player);

    await interaction.editReply(`Tocando: **${videoTitle}**`);

    player.once(AudioPlayerStatus.Idle, () => {
      const conn = getVoiceConnection(interaction.guildId!);
      conn?.destroy();
    });

    return;
  }

  // ── /stop ──────────────────────────────────────────────────────────────────
  if (commandName === 'stop') {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection) {
      await interaction.reply({ content: 'Não estou em nenhum canal de voz.', ephemeral: true });
      return;
    }

    player.stop(true);
    connection.destroy();
    await interaction.reply('Parado e desconectado.');
  }
});

client.login(TOKEN);
