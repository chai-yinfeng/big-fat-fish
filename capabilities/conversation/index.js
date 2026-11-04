/** Shared channel face; validation and durable state stay in Authority. */
export class ConversationPort {
  #client;
  constructor(authorityClient) { this.#client = authorityClient; }
  observe(input) { return this.#client.observe(input); }
  context(input) { return this.#client.context(input); }
  submit(proposal) { return this.#client.submit(proposal); }
  receipt(id) { return this.#client.getReceipt(id); }
}
