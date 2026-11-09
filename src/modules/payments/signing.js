// Called after a payment commits so the TSE signs it (ADR-0005). #26 fills
// this in; tests swap `signing.requestSigning` to see the call.
export const signing = {
  requestSigning: async (_paymentId) => {},
};

export const requestSigning = (paymentId) => signing.requestSigning(paymentId);
