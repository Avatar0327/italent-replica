/** F-307：员工角色按 UUID 的严格顺序分配，调用方在分配后才建立申请或同步关系。 */
export async function orderedEmployeePair<T>(
  worker: T,
  makePerson: () => Promise<T>,
  idOf: (person: T) => string,
  order: 'below' | 'above',
): Promise<{ worker: T; subordinate: T }> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const subordinate = await makePerson();
    if ((order === 'below') === idOf(subordinate) < idOf(worker)) return { worker, subordinate };
  }
  throw new Error('造不出指定 UUID 顺序的下属');
}
