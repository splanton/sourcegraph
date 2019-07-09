import { ProxyResult, ProxyValue, proxyValue, proxyValueSymbol } from '@sourcegraph/comlink'
import { Unsubscribable } from 'rxjs'
import * as sourcegraph from 'sourcegraph'
import { ProxySubscribable } from '../../extension/api/common'
import { StatusService } from '../services/checkService'
import { wrapRemoteObservable } from './common'
import { TransferableStatus } from '../../types/check'

export interface ClientStatusAPI extends ProxyValue {
    $registerStatusProvider(
        name: Parameters<typeof sourcegraph.status.registerStatusProvider>[0],
        providerFunction: ProxyResult<
            ((
                ...args: Parameters<sourcegraph.StatusProvider['provideStatus']>
            ) => ProxySubscribable<TransferableStatus | null>) &
                ProxyValue
        >
    ): Unsubscribable & ProxyValue
}

export function createClientStatus(statusService: StatusService): ClientStatusAPI {
    return {
        $registerStatusProvider: (name, providerFunction) => {
            return proxyValue(
                statusService.registerStatusProvider(name, {
                    provideStatus: (...args) => wrapRemoteObservable(providerFunction(...args)),
                })
            )
        },
        [proxyValueSymbol]: true,
    }
}