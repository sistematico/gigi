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
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { config } from 'dotenv';

const require = createRequire(import.meta.url);
const dfi = require('d-fi-core');

config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEEZER_ARL = process.env.DEEZER_ARL;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN e CLIENT_ID precisam estar definidos no .env');
  process.exit(1);
}

if (!DEEZER_ARL) {
  console.error('DEEZER_ARL precisa estar definido no .env');
  process.exit(1);
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca uma música do Deezer no canal de voz')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('URL do Deezer ou termo de busca')
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

// ─── Deezer helpers ──────────────────────────────────────────────────────────

const DEEZER_TRACK_RE = /deezer\.com\/(?:\w+\/)?track\/(\d+)/;

interface DfiTrack {
  SNG_ID: string;
  SNG_TITLE: string;
  ART_NAME: string;
  VERSION?: string;
}

async function fetchTrack(query: string): Promise<DfiTrack> {
  const match = query.match(DEEZER_TRACK_RE);

  if (match) {
    return await dfi.getTrackInfo(match[1]);
  }

  const results = await dfi.searchMusic(query, ['TRACK'], 1);
  const tracks = results?.TRACK?.data;

  if (!tracks?.length) {
    throw new Error('Nenhum resultado encontrado.');
  }

  return tracks[0];
}

async function downloadTrack(track: DfiTrack): Promise<Buffer> {
  const dlInfo = await dfi.getTrackDownloadUrl(track, 1);

  if (!dlInfo) {
    throw new Error('Faixa indisponível para download.');
  }

  const res = await fetch(dlInfo.trackUrl);

  if (!res.ok) {
    throw new Error(`Erro ao baixar faixa: ${res.status}`);
  }

  const raw = Buffer.from(await res.arrayBuffer());
  return dlInfo.isEncrypted ? dfi.decryptDownload(raw, track.SNG_ID) : raw;
}

function trackDisplayName(track: DfiTrack): string {
  const version = track.VERSION ? ` (${track.VERSION})` : '';
  return `${track.ART_NAME} - ${track.SNG_TITLE}${version}`;
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Pronto! Logado como ${readyClient.user.tag}`);

  await dfi.initDeezerApi(DEEZER_ARL);
  console.log('Deezer API inicializada.');

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

    try {
      const track = await fetchTrack(query);
      const audioBuffer = await downloadTrack(track);
      const stream = Readable.from(audioBuffer);

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

      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
      });

      player.play(resource);
      connection.subscribe(player);

      await interaction.editReply(`Tocando: **${trackDisplayName(track)}**`);

      player.once(AudioPlayerStatus.Idle, () => {
        const conn = getVoiceConnection(interaction.guildId!);
        conn?.destroy();
      });
    } catch (error) {
      console.error('Erro ao processar /play:', error);
      const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
      await interaction.editReply(`Não foi possível reproduzir: ${msg}`);
    }

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
