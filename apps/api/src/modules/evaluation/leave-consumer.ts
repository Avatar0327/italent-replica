/** C2-1b / DEC-447：生产启动装配；通用注册协议与业务处理器分开，避免测试代替生产登记。 */
import { registerLeaveConsumer } from './leave-consumer-registry.js';
import { evaluationLeaveConsumer } from './leave-handler.js';

registerLeaveConsumer(evaluationLeaveConsumer);
export { maybeStartLeaveConsumerScheduler, registerLeaveConsumer } from './leave-consumer-registry.js';
