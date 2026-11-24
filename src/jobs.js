// 新建支线的首章任务先把支线 ID 写进 result，普通续写则直接绑定 branch_id。
export function jobOwnsBranch(job, branchId) {
  return typeof branchId === 'string' && branchId.length > 0
    && (job.branch_id === branchId || job.result?.branch_id === branchId);
}
