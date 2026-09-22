import Pay from "paysdk";

const pay = new Pay("sk_test");

export async function nextInvoice(customer: string) {
  return pay.invoices.retrieveUpcoming({ customer });
}

export async function invoice(id: string) {
  return pay.invoices.retrieve(id);
}
