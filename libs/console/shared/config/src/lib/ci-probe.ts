// CI probe for #5, never merged: breaks the lint rules on purpose (layer boundary + no-debugger).
import { HelloPage } from '@console/pages/hello';

export function ciProbe(): unknown {
  debugger;
  return HelloPage;
}
