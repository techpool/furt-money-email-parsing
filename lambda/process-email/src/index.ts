import { GetObjectCommand, GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3'
import type { SESEvent } from 'aws-lambda'
import { Readable } from 'stream'

const s3 = new S3Client({})

const EMAIL_BUCKET = process.env.EMAIL_BUCKET
const EMAIL_PREFIX = process.env.EMAIL_PREFIX ?? 'raw/'

if (!EMAIL_BUCKET) {
  throw new Error('EMAIL_BUCKET environment variable must be set')
}

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

    const size = response.ContentLength ?? (await consumeBody(response.Body))

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
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('process-email: Failed to read message from S3', {
      messageId,
      bucket: EMAIL_BUCKET,
      objectKey,
      error,
    })
    throw error
  }
}

async function consumeBody(body: GetObjectCommandOutput['Body']): Promise<number> {
  if (!body) {
    return 0
  }

  if (typeof (body as any).transformToByteArray === 'function') {
    const bytes = await (body as any).transformToByteArray()
    return bytes.length
  }

  if (body instanceof Readable) {
    let size = 0
    for await (const chunk of body) {
      size += Buffer.byteLength(chunk)
    }
    return size
  }

  const buffer = Buffer.from(body as any)
  return buffer.byteLength
}
