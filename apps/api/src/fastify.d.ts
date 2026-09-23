import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact bytes of the request body, captured before JSON parsing.
     *
     * Webhook signatures are computed over the raw payload. Parsing and re-serialising
     * changes key order and whitespace, which changes the digest — so the verification has
     * to see the original bytes or it will fail in a way that looks like a bad credential.
     */
    rawBody?: Buffer;
  }
}
