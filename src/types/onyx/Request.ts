import type {OnyxUpdate} from 'react-native-onyx';
import type Response from './Response';

type OnyxData = {
    successData?: OnyxUpdate[];
    failureData?: OnyxUpdate[];
    optimisticData?: OnyxUpdate[];
};

type RequestType = 'get' | 'post';

type RequestData = {
    command: string;
    commandName?: string;
    data?: Record<string, unknown>;
    type?: RequestType;
    shouldUseSecure?: boolean;
    successData?: OnyxUpdate[];
    failureData?: OnyxUpdate[];
    idempotencyKey?: string;

    resolve?: (value: Response) => void;
    reject?: (value?: unknown) => void;
};

type Request = RequestData & OnyxData;

export default Request;
export type {OnyxData, RequestType};
