import { Client } from "cassandra-driver"
import type { Env } from "../env.js"

const createDbClient = (env: Env) => {
  const client = new Client({
    contactPoints: [env.SCYLLA_HOST],
    localDataCenter: env.SCYLLA_DATACENTER,
    keyspace: env.SCYLLA_KEYSPACE,
    credentials: env.SCYLLA_USERNAME
      ? {
          username: env.SCYLLA_USERNAME,
          password: env.SCYLLA_PASSWORD!,
        }
      : undefined,
    protocolOptions: {
      port: env.SCYLLA_PORT,
    },
  })

  const connect = async () => {
    try {
      await client.connect()
      client.hosts.values().forEach((host: { setMaxListeners: (n: number) => void }) => {
        host.setMaxListeners(20)
      })
    } catch (error) {
      throw new Error(`Failed to connect to ScyllaDB: ${error}`, { cause: error })
    }
  }

  const disconnect = async () => {
    await client.shutdown()
  }

  return { client, connect, disconnect }
}

export { createDbClient }
