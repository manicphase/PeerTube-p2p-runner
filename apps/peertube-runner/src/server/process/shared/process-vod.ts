import { remove } from 'fs-extra/esm'
import { join } from 'path'
import {
  RunnerJobVODAudioMergeTranscodingPayload,
  RunnerJobVODHLSTranscodingPayload,
  RunnerJobVODWebVideoTranscodingPayload,
  VODAudioMergeTranscodingSuccess,
  VODHLSTranscodingSuccess,
  VODWebVideoTranscodingSuccess
} from '@peertube/peertube-models'
import { buildUUID } from '@peertube/peertube-node-utils'
import { ConfigManager } from '../../../shared/config-manager.js'
import { logger } from '../../../shared/index.js'
import { buildFFmpegVOD, downloadInputFile, ProcessOptions, scheduleTranscodingProgress } from './common.js'
import WebTorrent from 'webtorrent'
import { waitUntil } from 'async-wait-until'

const cachefolder = "~/.pt_cache"
const wt = new WebTorrent()
let torrentList = {}
let countDowns = {}

wt.on("torrent",(t) => {torrentList[t.infoHash] = t})
logger.info("Webtorrent client initialised")


async function parseTorrentURL (inputURL: string) {

  let fileURL = new URL(inputURL)
  let videoID = fileURL.pathname.split("/")[8]
  let videoURL = `${fileURL.origin}/api/v1/videos/${videoID}`
  let magnetURI 
  let thisTorrent = {done: false, files:[], infoHash:""}
  logger.info(`new video URL is ${videoURL}`) 
  await fetch(videoURL).then(r => r.json())
  .then(r => {
              if (r.files[0]) {
                logger.info('using files magnetURI')
                magnetURI = r.files[0].magnetUri
              }
              else {
                logger.info(`using streamingPlaylists magnetURI`)
                magnetURI = r.streamingPlaylists[0].files[0].magnetUri
              }
              let newInfohash = magnetURI.split("btih:")[1].split("&")[0]
              if (countDowns[newInfohash]) {
                clearTimeout(countDowns[newInfohash])
                delete countDowns[newInfohash]
              }
              let existingHashes = wt.torrents.map(function(t) {return t.infoHash})
              if (existingHashes.indexOf(newInfohash) < 0) {
                wt.add(magnetURI, { path: cachefolder }, function (torrent) {
                  thisTorrent = torrent
                  const interval = setInterval(function () {
                    logger.info(`Progress: ${(torrent.progress * 100).toFixed(1)}% from ${torrent.numPeers}`)
                  }, 5000)
                  torrent.on('done', function () {
                    logger.info('torrent download finished')  
                    clearInterval(interval)                  
                  })
                })
              } else thisTorrent = wt.torrents.filter((t) => t.infoHash === newInfohash)[0]

  })
  await waitUntil(() => thisTorrent.done, {timeout: 86000000})
  let fileDir = `${cachefolder}/${thisTorrent.files[0].path}`
  logger.info(`file downloaded to ${fileDir}`)
  logger.info("DOWNLOAD DONE")
  return thisTorrent.infoHash
}

export async function processWebVideoTranscoding (options: ProcessOptions<RunnerJobVODWebVideoTranscodingPayload>) {
  const { server, job, runnerToken } = options

  const payload = job.payload


  let ffmpegProgress: number
  let inputPath: string
  let infoHash: string

  const outputPath = join(ConfigManager.Instance.getTranscodingDirectory(), `output-${buildUUID()}.mp4`)

  const updateProgressInterval = scheduleTranscodingProgress({
    job,
    server,
    runnerToken,
    progressGetter: () => ffmpegProgress
  })

  try {
    logger.info(`[processWebVideoTranscoding] Downloading input file ${payload.input.videoFileUrl} for web video transcoding job ${job.jobToken}`)

    try{
      infoHash = await parseTorrentURL(payload.input.videoFileUrl)
      inputPath = `${cachefolder}/${torrentList[infoHash].files[0].path}`
    } catch {
      logger.info("failed to get torrent. using direct download.")
      inputPath = await downloadInputFile({ url: payload.input.videoFileUrl, runnerToken, job })
    }

    logger.info(`Downloaded input file ${payload.input.videoFileUrl} for job ${job.jobToken}. Running web video transcoding.`)

    const ffmpegVod = buildFFmpegVOD({
      onJobProgress: progress => { ffmpegProgress = progress }
    })

    await ffmpegVod.transcode({
      type: 'video',

      inputPath,

      outputPath,

      inputFileMutexReleaser: () => {},

      resolution: payload.output.resolution,
      fps: payload.output.fps
    })

    const successBody: VODWebVideoTranscodingSuccess = {
      videoFile: outputPath
    }

    await server.runnerJobs.success({
      jobToken: job.jobToken,
      jobUUID: job.uuid,
      runnerToken,
      payload: successBody
    })
  } finally {
    if (infoHash) {
      countDowns[infoHash] = setTimeout(() => {remove(inputPath)},60000)
      if (torrentList[infoHash]) torrentList[infoHash].destroy()
    } else {
      await remove(inputPath)
    }
    if (torrentList[infoHash]) torrentList[infoHash].destroy()
    if (outputPath) await remove(outputPath)
    if (updateProgressInterval) clearInterval(updateProgressInterval)
  }
}

export async function processHLSTranscoding (options: ProcessOptions<RunnerJobVODHLSTranscodingPayload>) {
  const { server, job, runnerToken } = options
  const payload = job.payload

  let ffmpegProgress: number
  let inputPath: string
  let infoHash: string

  const uuid = buildUUID()
  const outputPath = join(ConfigManager.Instance.getTranscodingDirectory(), `${uuid}-${payload.output.resolution}.m3u8`)
  const videoFilename = `${uuid}-${payload.output.resolution}-fragmented.mp4`
  const videoPath = join(join(ConfigManager.Instance.getTranscodingDirectory(), videoFilename))

  const updateProgressInterval = scheduleTranscodingProgress({
    job,
    server,
    runnerToken,
    progressGetter: () => ffmpegProgress
  })

  try {
    logger.info(`[processHLSTranscoding] Downloading input file ${payload.input.videoFileUrl} for HLS transcoding job ${job.jobToken}`)

    try{
      infoHash = await parseTorrentURL(payload.input.videoFileUrl)
      inputPath = `${cachefolder}/${torrentList[infoHash].files[0].path}`
    } catch {
      logger.info("failed to get torrent. using direct download.")
      inputPath = await downloadInputFile({ url: payload.input.videoFileUrl, runnerToken, job })
    }

    logger.info(`Downloaded input file ${payload.input.videoFileUrl} for job ${job.jobToken}. Running HLS transcoding.`)

    const ffmpegVod = buildFFmpegVOD({
      onJobProgress: progress => { ffmpegProgress = progress }
    })

    await ffmpegVod.transcode({
      type: 'hls',
      copyCodecs: false,
      inputPath,
      hlsPlaylist: { videoFilename },
      outputPath,

      inputFileMutexReleaser: () => {},

      resolution: payload.output.resolution,
      fps: payload.output.fps
    })

    const successBody: VODHLSTranscodingSuccess = {
      resolutionPlaylistFile: outputPath,
      videoFile: videoPath
    }

    await server.runnerJobs.success({
      jobToken: job.jobToken,
      jobUUID: job.uuid,
      runnerToken,
      payload: successBody
    })
  } finally {
    if (infoHash) {
      countDowns[infoHash] = setTimeout(() => {remove(inputPath)},60000)
      if (torrentList[infoHash]) torrentList[infoHash].destroy()
    } else {
      await remove(inputPath)
    }
    if (outputPath) await remove(outputPath)
    if (videoPath) await remove(videoPath)
    if (updateProgressInterval) clearInterval(updateProgressInterval)
  }
}

export async function processAudioMergeTranscoding (options: ProcessOptions<RunnerJobVODAudioMergeTranscodingPayload>) {
  const { server, job, runnerToken } = options
  const payload = job.payload

  let ffmpegProgress: number
  let audioPath: string
  let inputPath: string

  const outputPath = join(ConfigManager.Instance.getTranscodingDirectory(), `output-${buildUUID()}.mp4`)

  const updateProgressInterval = scheduleTranscodingProgress({
    job,
    server,
    runnerToken,
    progressGetter: () => ffmpegProgress
  })

  try {
    logger.info(
      `Downloading input files ${payload.input.audioFileUrl} and ${payload.input.previewFileUrl} ` +
      `for audio merge transcoding job ${job.jobToken}`
    )

    audioPath = await downloadInputFile({ url: payload.input.audioFileUrl, runnerToken, job })
    inputPath = await downloadInputFile({ url: payload.input.previewFileUrl, runnerToken, job })

    logger.info(
      `Downloaded input files ${payload.input.audioFileUrl} and ${payload.input.previewFileUrl} ` +
      `for job ${job.jobToken}. Running audio merge transcoding.`
    )

    const ffmpegVod = buildFFmpegVOD({
      onJobProgress: progress => { ffmpegProgress = progress }
    })

    await ffmpegVod.transcode({
      type: 'merge-audio',

      audioPath,
      inputPath,

      outputPath,

      inputFileMutexReleaser: () => {},

      resolution: payload.output.resolution,
      fps: payload.output.fps
    })

    const successBody: VODAudioMergeTranscodingSuccess = {
      videoFile: outputPath
    }

    await server.runnerJobs.success({
      jobToken: job.jobToken,
      jobUUID: job.uuid,
      runnerToken,
      payload: successBody
    })
  } finally {
    if (audioPath) await remove(audioPath)
    if (inputPath) await remove(inputPath)
    if (outputPath) await remove(outputPath)
    if (updateProgressInterval) clearInterval(updateProgressInterval)
  }
}
