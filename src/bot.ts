import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type TextChannel,
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
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
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
    .setDescription('Toca uma música do Deezer ou YouTube no canal de voz')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('URL do Deezer, YouTube ou termo de busca')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Exibe botões para tocar rádios shoutcast/icecast predefinidas'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a reprodução e desconecta do canal de voz'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula a música atual da fila'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Exibe a fila de reprodução atual'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove uma música da fila pelo número')
    .addIntegerOption(option =>
      option
        .setName('posicao')
        .setDescription('Número da música na fila (use /queue para ver)')
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta o volume da reprodução (0–100)')
    .addIntegerOption(option =>
      option
        .setName('nivel')
        .setDescription('Nível de volume entre 0 e 100')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    ),
] as const;

// ─── Radio stations ───────────────────────────────────────────────────────────

interface RadioStation {
  id: string;
  name: string;
  emoji: string;
  url: string;
}

const RADIO_STATIONS: RadioStation[] = [
  { id: 'sdm',      name: 'Som do Mato',    emoji: '🌎', url: 'https://radio.somdomato.com/geral' },
  { id: 'rtm',      name: 'Rhythm Place',    emoji: '🌎', url: 'https://stream.rhythm.place/main.mp3' },
  { id: 'jovempan',       name: 'Jovem Pan',      emoji: '📻', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/JOVEMPANFM.mp3' },
  { id: 'antena1',        name: 'Antena 1',       emoji: '🎵', url: 'https://antenaone.crossradio.com.br/stream/1' },
  { id: 'cbn',            name: 'CBN',            emoji: '🗣️', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CBNAM.mp3' },
  { id: 'metropolitana',  name: 'Metropolitana',  emoji: '🏙️', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/METROPOLITANAFM.mp3' },
  { id: 'transamerica',   name: 'Transamérica',   emoji: '🌎', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/TRANSAMFM.mp3' },
  { id: 'bandnews',       name: 'BandNews',       emoji: '📰', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/BANDNEWSFM.mp3' },
  { id: 'mix',            name: 'Mix FM',         emoji: '🎶', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/MIXFM.mp3' },
  { id: 'cultura',        name: 'Rádio Cultura',  emoji: '🎼', url: 'https://streaming.rts.com.br/radiocultura' },
  { id: 'alpha',          name: 'Alpha FM',       emoji: '✨', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ALPHAFM.mp3' },
];

// ─── Deezer helpers ──────────────────────────────────────────────────────────

const DEEZER_TRACK_RE = /deezer\.com\/(?:\w+\/)?track\/(\d+)/;

interface DfiTrack {
  SNG_ID: string;
  SNG_TITLE: string;
  ART_NAME: string;
  VERSION?: string;
}


const YOUTUBE_URL_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{11})/;

// ─── yt-dlp helpers ───────────────────────────────────────────────────────────

/** Obtém título e URL final de um vídeo ou pesquisa (ytsearch1:query). */
function ytdlpGetInfo(input: string): Promise<{ url: string; title: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '--print', 'title',
      '--print', 'webpage_url',
      '--no-download',
      '--no-warnings',
      input,
    ]);
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', (code: number | null) => {
      const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      if (code === 0 && lines.length >= 2) {
        resolve({ title: lines[0], url: lines[1] });
      } else {
        reject(new Error('Nenhum resultado encontrado no YouTube.'));
      }
    });
    proc.on('error', (err: Error) =>
      reject(new Error(`yt-dlp não encontrado no PATH: ${err.message}`)),
    );
  });
}

/** Retorna um Readable com o áudio de um vídeo YouTube via yt-dlp. */
function ytdlpStream(url: string): Readable {
  const proc = spawn('yt-dlp', [
    '--no-playlist',
    '-f', 'bestaudio/best',
    '--no-warnings',
    '-o', '-',
    url,
  ]);
  proc.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.error('[yt-dlp]', line);
  });
  proc.on('close', (code: number | null) => {
    if (code !== 0) console.error(`[yt-dlp] processo encerrado com código ${code}`);
  });
  return proc.stdout as unknown as Readable;
}

async function fetchTrack(query: string): Promise<
  | { type: 'deezer'; track: DfiTrack }
  | { type: 'youtube'; url: string; title: string }
> {
  // Deezer URL
  const deezerMatch = query.match(DEEZER_TRACK_RE);
  if (deezerMatch) {
    const track = await dfi.getTrackInfo(deezerMatch[1]);
    return { type: 'deezer', track };
  }

  // YouTube URL direto
  if (YOUTUBE_URL_RE.test(query)) {
    const { url, title } = await ytdlpGetInfo(query);
    return { type: 'youtube', url, title };
  }

  // Busca no Deezer primeiro
  const results = await dfi.searchMusic(query, ['TRACK'], 1);
  const tracks = results?.TRACK?.data;
  if (tracks?.length) {
    return { type: 'deezer', track: tracks[0] };
  }

  // Busca no YouTube via yt-dlp
  const { url, title } = await ytdlpGetInfo(`ytsearch1:${query}`);
  return { type: 'youtube', url, title };
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

// ─── Radio stream helper ──────────────────────────────────────────────────────

function fetchRadioStream(url: string, redirects = 5): Promise<Readable> {
  return new Promise((resolve, reject) => {
    if (redirects === 0) {
      reject(new Error('Muitos redirecionamentos ao conectar à rádio.'));
      return;
    }
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Icy-MetaData': '0' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchRadioStream(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ao conectar à rádio.`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ─── Volume & queue state ─────────────────────────────────────────────────────

let currentVolume = 0.2; // 20% por padrão

interface QueueItem {
  title: string;
  addedBy: string;     // userId
  addedByTag: string;  // username para display
  resolved: { type: 'deezer'; track: DfiTrack } | { type: 'youtube'; url: string; title: string };
}

let queue: QueueItem[] = [];
let currentItem: QueueItem | null = null;
let radioState: { stationName: string; emoji: string; startedBy: string } | null = null;
let activeGuildId: string | null = null;
let activeVoiceChannelId: string | null = null;
let activeTextChannelId: string | null = null;
let isProcessingQueue = false;

// ─── Permission helper ────────────────────────────────────────────────────────

function isAdmin(member: GuildMember): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

// ─── Audio player ─────────────────────────────────────────────────────────────

const player = createAudioPlayer();

player.on('error', error => {
  console.error('Erro no player de áudio:', error.message);
});

// ─── Playlist state management ────────────────────────────────────────────────

function clearPlayerState(): void {
  queue = [];
  currentItem = null;
  radioState = null;
  activeGuildId = null;
  activeVoiceChannelId = null;
  activeTextChannelId = null;
  isProcessingQueue = false;
}

async function playNextInQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  if (queue.length === 0) {
    isProcessingQueue = false;
    currentItem = null;
    if (activeGuildId) {
      const conn = getVoiceConnection(activeGuildId);
      conn?.destroy();
    }
    clearPlayerState();
    return;
  }

  const item = queue.shift()!;
  currentItem = item;

  try {
    let resource: ReturnType<typeof createAudioResource>;

    if (item.resolved.type === 'deezer') {
      const audioBuffer = await downloadTrack(item.resolved.track);
      const stream = Readable.from(audioBuffer);
      resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    } else {
      const ytStream = ytdlpStream(item.resolved.url);
      resource = createAudioResource(ytStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    }

    resource.volume?.setVolume(currentVolume);

    player.play(resource);
    // isProcessingQueue só é liberado quando o player entrar em Playing (via stateChange)

    // Anuncia no canal de texto
    if (activeTextChannelId && activeGuildId) {
      try {
        const guild = await client.guilds.fetch(activeGuildId);
        const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
        await channel?.send(`▶ Tocando: **${item.title}** — adicionado por **${item.addedByTag}**`);
      } catch {
        // falha silenciosa no anúncio
      }
    }
  } catch (error) {
    console.error('[playNextInQueue] erro ao carregar faixa:', error);
    currentItem = null;
    isProcessingQueue = false;

    // Anuncia erro e tenta próxima (se houver)
    if (activeTextChannelId && activeGuildId) {
      try {
        const guild = await client.guilds.fetch(activeGuildId);
        const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
        const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
        await channel?.send(`⚠️ Não foi possível reproduzir **${item.title}**: ${msg}`);
      } catch { /* silencioso */ }
    }

    if (queue.length > 0) {
      playNextInQueue().catch(err => console.error('[playNextInQueue] erro na faixa seguinte:', err));
    }
    // Não destrói a conexão em caso de erro — aguarda próximo /play ou /stop
  }
}

// Avança fila automaticamente ao terminar
player.on('stateChange', (oldState, newState) => {
  // Libera o lock assim que o player começa a tocar de verdade
  if (newState.status === AudioPlayerStatus.Playing) {
    isProcessingQueue = false;
  }

  // Avança a fila quando uma faixa termina (ou falha após ter iniciado)
  if (
    !isProcessingQueue &&
    oldState.status !== AudioPlayerStatus.Idle &&
    newState.status === AudioPlayerStatus.Idle &&
    radioState === null
  ) {
    playNextInQueue().catch(err => console.error('[stateChange] erro:', err));
  }
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
  try {
  // ── /radio (botões) ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('radio_')) {
    const stationId = interaction.customId.slice('radio_'.length);
    const station = RADIO_STATIONS.find(s => s.id === stationId);
    if (!station) {
      await interaction.reply({ content: 'Rádio não encontrada.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Você precisa estar em um canal de voz para usar este botão.',
        ephemeral: true,
      });
      return;
    }

    // Bloqueia rádio se há playlist ativa e o usuário não é admin
    if ((currentItem !== null || queue.length > 0) && !isAdmin(member)) {
      await interaction.reply({
        content: 'O bot está no modo playlist. Apenas administradores podem iniciar uma rádio agora.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    // Admin interrompendo playlist ativa: limpa estado antes de iniciar a rádio
    if (currentItem !== null || queue.length > 0) {
      player.stop(true);
      if (activeGuildId) {
        const conn = getVoiceConnection(activeGuildId);
        conn?.destroy();
      }
      clearPlayerState();
    }

    try {
      const stream = await fetchRadioStream(station.url);
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      resource.volume?.setVolume(currentVolume);

      let connection = getVoiceConnection(interaction.guildId!);
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

      radioState = { stationName: station.name, emoji: station.emoji, startedBy: interaction.user.id };
      activeGuildId = interaction.guildId!;

      player.play(resource);
      connection.subscribe(player);

      await interaction.editReply(`${station.emoji} Tocando **${station.name}** ao vivo!`);
    } catch (error) {
      console.error('Erro ao tocar rádio:', error);
      const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
      await interaction.editReply(`Não foi possível tocar a rádio: ${msg}`);
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guildId) {
    await interaction.reply({ content: 'Este comando só pode ser usado dentro de um servidor.', ephemeral: true });
    return;
  }

  const { commandName } = interaction;

  // ── /radio ─────────────────────────────────────────────────────────────────
  if (commandName === 'radio') {
    // Divide as estações em linhas de até 5 botões
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < RADIO_STATIONS.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        RADIO_STATIONS.slice(i, i + 5).map(s =>
          new ButtonBuilder()
            .setCustomId(`radio_${s.id}`)
            .setLabel(s.name)
            .setEmoji(s.emoji)
            .setStyle(ButtonStyle.Secondary),
        ),
      );
      rows.push(row);
    }

    await interaction.reply({
      content: '📻 Escolha uma rádio para tocar no seu canal de voz:',
      components: rows,
    });
    return;
  }

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

    // Bloqueia /play durante rádio para não-admins
    if (radioState !== null && !isAdmin(member)) {
      await interaction.reply({
        content: `O bot está tocando a rádio **${radioState.stationName}** ao vivo. Apenas administradores podem interromper.`,
        ephemeral: true,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    try {
      // Resolve título e fonte agora; o download/stream ocorre em playNextInQueue
      const resolved = await fetchTrack(query);
      const title = resolved.type === 'deezer' ? trackDisplayName(resolved.track) : resolved.title;

      // Admin interrompendo rádio: para e limpa estado
      if (radioState !== null) {
        player.stop(true);
        if (activeGuildId) {
          const conn = getVoiceConnection(activeGuildId);
          conn?.destroy();
        }
        clearPlayerState();
      }

      const item: QueueItem = {
        title,
        addedBy: interaction.user.id,
        addedByTag: interaction.user.tag ?? interaction.user.username,
        resolved,
      };

      queue.push(item);
      activeTextChannelId = interaction.channelId;
      activeGuildId = interaction.guildId;
      activeVoiceChannelId = voiceChannel.id;

      // Conecta ao canal de voz se ainda não estiver conectado
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
          queue.pop();
          await interaction.editReply('Não foi possível conectar ao canal de voz.');
          return;
        }
      }

      // Sempre garante que o player está inscrito na conexão ativa
      connection.subscribe(player);

      const isIdle = player.state.status === AudioPlayerStatus.Idle;
      if (isIdle) {
        await interaction.editReply(`✅ **${title}** adicionado à fila`);
        playNextInQueue().catch(err => console.error('[play] erro em playNextInQueue:', err));
      } else {
        await interaction.editReply(`✅ **${title}** adicionado à fila na posição **${queue.length}**`);
      }
    } catch (error) {
      console.error('Erro ao processar /play:', error);
      const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
      await interaction.editReply(`Não foi possível reproduzir: ${msg}`);
    }

    return;
  }

  // ── /stop ──────────────────────────────────────────────────────────────────
  if (commandName === 'stop') {
    const member = interaction.member as GuildMember;
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection && radioState === null && currentItem === null && queue.length === 0) {
      await interaction.reply({ content: 'Não estou em nenhum canal de voz.', ephemeral: true });
      return;
    }

    // Verifica permissão
    if (radioState !== null) {
      if (!isAdmin(member) && interaction.user.id !== radioState.startedBy) {
        await interaction.reply({
          content: 'Apenas quem iniciou a rádio ou administradores podem parar a reprodução.',
          ephemeral: true,
        });
        return;
      }
    } else {
      if (!isAdmin(member)) {
        await interaction.reply({
          content: 'Apenas administradores podem parar a playlist.',
          ephemeral: true,
        });
        return;
      }
    }

    player.stop(true);
    connection?.destroy();
    clearPlayerState();
    await interaction.reply('⏹ Parado e desconectado.');
    return;
  }

  // ── /skip ──────────────────────────────────────────────────────────────────
  if (commandName === 'skip') {
    if (radioState !== null) {
      await interaction.reply({ content: 'Não é possível pular uma rádio. Use `/stop` para parar.', ephemeral: true });
      return;
    }

    if (!currentItem) {
      await interaction.reply({ content: 'Nenhuma música está tocando no momento.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    if (!isAdmin(member) && interaction.user.id !== currentItem.addedBy) {
      await interaction.reply({
        content: 'Apenas quem adicionou a música ou administradores podem pulá-la.',
        ephemeral: true,
      });
      return;
    }

    const skipped = currentItem.title;
    currentItem = null;
    isProcessingQueue = false; // libera lock antes de parar
    player.stop(true); // stateChange → Idle → playNextInQueue()
    await interaction.reply(`⏭ **${skipped}** pulada.`);
    return;
  }

  // ── /queue ─────────────────────────────────────────────────────────────────
  if (commandName === 'queue') {
    if (radioState !== null) {
      await interaction.reply(`📻 Tocando rádio ao vivo: **${radioState.stationName}** ${radioState.emoji}`);
      return;
    }

    if (!currentItem && queue.length === 0) {
      await interaction.reply('📭 A fila está vazia.');
      return;
    }

    const lines: string[] = [];
    if (currentItem) {
      lines.push(`▶ **Tocando agora:** ${currentItem.title} — adicionado por **${currentItem.addedByTag}**`);
    }
    if (queue.length > 0) {
      lines.push('');
      lines.push('**Na fila:**');
      queue.forEach((item, i) => {
        lines.push(`${i + 1}. ${item.title} — adicionado por **${item.addedByTag}**`);
      });
    }

    await interaction.reply(lines.join('\n'));
    return;
  }

  // ── /remove ────────────────────────────────────────────────────────────────
  if (commandName === 'remove') {
    if (radioState !== null) {
      await interaction.reply({ content: 'Não há fila ativa durante uma rádio.', ephemeral: true });
      return;
    }

    const pos = interaction.options.getInteger('posicao', true);
    if (pos > queue.length) {
      await interaction.reply({
        content: `Posição inválida. A fila tem **${queue.length}** item(s). Use \`/queue\` para ver.`,
        ephemeral: true,
      });
      return;
    }

    const item = queue[pos - 1];
    const member = interaction.member as GuildMember;
    if (!isAdmin(member) && interaction.user.id !== item.addedBy) {
      await interaction.reply({
        content: 'Apenas quem adicionou a música ou administradores podem removê-la da fila.',
        ephemeral: true,
      });
      return;
    }

    queue.splice(pos - 1, 1);
    await interaction.reply(`🗑 **${item.title}** removida da fila.`);
    return;
  }

  // ── /volume ────────────────────────────────────────────────────────────────
  if (commandName === 'volume') {
    const nivel = interaction.options.getInteger('nivel', true);
    currentVolume = nivel / 100;

    const state = player.state;
    if (state.status !== AudioPlayerStatus.Idle && 'resource' in state) {
      (state.resource as ReturnType<typeof createAudioResource>).volume?.setVolume(currentVolume);
    }

    await interaction.reply(`🔊 Volume ajustado para **${nivel}%**`);
    return;
  }
  } catch (err) {
    console.error('[InteractionCreate] erro não tratado:', err);
    try {
      const reply = { content: 'Ocorreu um erro interno. Tente novamente.', ephemeral: true };
      if (interaction.isRepliable()) {
        if ((interaction as any).deferred || (interaction as any).replied) {
          await (interaction as any).editReply(reply.content);
        } else {
          await (interaction as any).reply(reply);
        }
      }
    } catch { /* ignora falha ao responder o erro */ }
  }
});

client.login(TOKEN);
