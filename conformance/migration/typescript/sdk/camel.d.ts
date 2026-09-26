// A hand-written SDK that spells the wire's fields in its own language's
// style, as twilio-node's `friendlyName` is the wire's `friendly_name`.
export interface CustomerInstance {
  sid: string;
  nickName: string;
  emailAddress: string;
}

export declare class CustomerContext {
  fetch(): Promise<CustomerInstance>;
}

export declare class Twine {
  constructor(accountSid: string, authToken: string);
  customers(sid: string): CustomerContext;
}

export default Twine;
