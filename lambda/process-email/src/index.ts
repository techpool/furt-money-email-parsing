import { GetObjectCommand, GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3'
import type { SESEvent } from 'aws-lambda'
import { Readable } from 'stream'
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser'

const s3 = new S3Client({})

const EMAIL_BUCKET = getRequiredEnv('EMAIL_BUCKET')
const EMAIL_PREFIX = process.env.EMAIL_PREFIX ?? 'raw/'
const BACKEND_INGEST_URL = getRequiredEnv('BACKEND_INGEST_URL')
const BACKEND_INGEST_TOKEN = getRequiredEnv('BACKEND_INGEST_TOKEN')
const MAX_BODY_CHARS = normalizeMaxBodyChars(process.env.EMAIL_BODY_MAX_CHARS)

type BackendAddress = {
  address: string
  name?: string
}

type EmailIngestPayload = {
  messageId: string
  from: BackendAddress
  to: BackendAddress[]
  cc?: BackendAddress[]
  subject?: string | null
  text?: string | null
  html?: string | null
  snippet?: string | null
  receivedAt: string
  rawSize?: number
  recipients: string[]
  mailSource?: string
  s3: {
    bucket: string
    key: string
  }
}

type SesPayload = NonNullable<SESEvent['Records'][number]['ses']>
type AddressInput = AddressObject | AddressObject[] | EmailAddress | EmailAddress[] | undefined

export const handler = async (event: SESEvent): Promise<void> => {
  const record = event.Records?.[0]?.ses
  if (!record) {
    console.warn('process-email: No SES record found in event payload', JSON.stringify(event))
    return
  }

  const messageId = record.mail.messageId
  const objectKey = `${EMAIL_PREFIX}${messageId}`

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: EMAIL_BUCKET,
        Key: objectKey,
      })
    )

    const rawMessage = await readObjectBody(response.Body)
    const size = response.ContentLength ?? rawMessage.length
    const parsedMessage = await simpleParser(rawMessage)

    const payload = buildIngestPayload({ record, parsedMessage, size, objectKey })
    await sendToBackend(payload)

    console.log(
      JSON.stringify(
        {
          level: 'INFO',
          action: 'process-email',
          messageId,
          objectKey,
          size,
          recipients: record.mail.destination,
          source: record.mail.source,
          status: 'forwarded',
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('process-email: Failed to handle inbound email', {
      messageId,
      bucket: EMAIL_BUCKET,
      objectKey,
      error,
    })
    throw error
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} environment variable must be set`)
  }

  return value
}

function normalizeMaxBodyChars(input?: string): number {
  if (!input) {
    return 20000
  }

  const parsed = Number(input)
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 20000
  }

  return parsed
}

async function readObjectBody(body: GetObjectCommandOutput['Body']): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0)
  }

  if (typeof (body as any).transformToByteArray === 'function') {
    const bytes = await (body as any).transformToByteArray()
    return Buffer.from(bytes)
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  return Buffer.from(body as any)
}

function isAddressObject(entry: unknown): entry is AddressObject {
  return Boolean(entry && typeof (entry as AddressObject).value !== 'undefined')
}

function isEmailAddress(entry: unknown): entry is EmailAddress {
  return Boolean(entry && typeof (entry as EmailAddress).address === 'string')
}

function hasAddress(entry: EmailAddress): entry is EmailAddress & { address: string } {
  return typeof entry.address === 'string' && entry.address.length > 0
}

function mapAddresses(address?: AddressInput): BackendAddress[] {
  const collected: EmailAddress[] = []

  const collect = (entry?: AddressInput | EmailAddress) => {
    if (!entry) {
      return
    }

    if (Array.isArray(entry)) {
      entry.forEach((value) => collect(value as AddressInput))
      return
    }

    if (isAddressObject(entry)) {
      entry.value.forEach((value) => collect(value))
      return
    }

    if (isEmailAddress(entry)) {
      collected.push(entry)
    }
  }

  collect(address)

  return collected
    .filter(hasAddress)
    .map((entry) => ({
      address: entry.address.toLowerCase(),
      name: entry.name?.trim() || undefined,
    }))
}

function truncateContent(content?: string | null): string | null {
  if (!content) {
    return null
  }

  if (content.length <= MAX_BODY_CHARS) {
    return content
  }

  return content.slice(0, MAX_BODY_CHARS)
}

function buildSnippet(parsed: { text?: string | null; html?: string | null }) {
  const sources = [parsed.text, parsed.html ? stripHtml(parsed.html) : null]
  const snippet = sources.find((value) => typeof value === 'string' && value.trim().length > 0)
  return snippet ? snippet.trim().slice(0, 500) : null
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ')
}

function buildIngestPayload(params: {
  record: SesPayload
  parsedMessage: Awaited<ReturnType<typeof simpleParser>>
  size: number
  objectKey: string
}): EmailIngestPayload {
  const { record, parsedMessage, size, objectKey } = params

  const to = mapAddresses(parsedMessage.to)
  const cc = mapAddresses(parsedMessage.cc)
  const from = mapAddresses(parsedMessage.from)[0]
  const fallbackSource = record.mail.source
    ? record.mail.source.toLowerCase()
    : 'unknown@sender'
  const textBody = typeof parsedMessage.text === 'string' ? parsedMessage.text : null
  const htmlBody = typeof parsedMessage.html === 'string' ? parsedMessage.html : null

  return {
    messageId: record.mail.messageId,
    from: from ?? { address: fallbackSource },
    to,
    cc: cc.length ? cc : undefined,
    subject: parsedMessage.subject ?? record.mail.commonHeaders?.subject ?? null,
    text: truncateContent(textBody),
    html: truncateContent(htmlBody),
    snippet: buildSnippet({
      text: textBody,
      html: htmlBody,
    }),
    receivedAt: record.mail.timestamp,
    rawSize: size,
    recipients: record.mail.destination?.map((recipient) => recipient.toLowerCase()) ?? [],
    mailSource: record.mail.source,
    s3: {
      bucket: EMAIL_BUCKET,
      key: objectKey,
    },
  }
}

async function sendToBackend(payload: EmailIngestPayload): Promise<void> {
  const response = await fetch(BACKEND_INGEST_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-email-ingest-token': BACKEND_INGEST_TOKEN!,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `Backend ingest failed with status ${response.status}: ${errorBody.slice(0, 500)}`
    )
  }
}
