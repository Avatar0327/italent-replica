/** F-307：员工角色按 UUID 的严格顺序分配，调用方在分配后才建立申请或同步关系。 */
export async function orderedEmployeePair<T>(
  worker: T,
  makePerson: () => Promise<T>,
  idOf: (person: T) => string,
  order: 'below' | 'above',
): Promise<{ worker: T; subordinate: T }> {
  const other = await makePerson();
  if (idOf(worker) === idOf(other)) throw new Error('顺序夹具需要两个不同的员工 UUID');
  return (order === 'below') === idOf(other) < idOf(worker)
    ? { worker, subordinate: other }
    : { worker: other, subordinate: worker };
}
