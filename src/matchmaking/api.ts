import type { BeaconsResponseDTO } from '../dtos.ts'
import { type HttpError, type HttpResponse, SafeHttpRequest, parseResponse } from '../http.ts'
import type {
  BackfillRequestDTO,
  BackfillResponseDTO,
  GroupDetailResponse,
  GroupUpRequestDTO,
  GroupUpResponseDTO,
  MonitorResponseDTO,
} from './dtos.ts'

type Success<T> = (value: T, response: HttpResponse) => void
type Done = (response: HttpResponse) => void

const PATH_MONITOR = 'monitor'
const PATH_BEACONS = 'locations/beacons'
const PATH_GROUP_UP = 'groups'
const PATH_BACKFILL = 'backfills'

export class Api {
  readonly request: SafeHttpRequest
  readonly authToken: string
  readonly baseUrl: string

  constructor(authToken: string, baseUrl: string, requestTimeoutSeconds = 0) {
    this.request = new SafeHttpRequest(requestTimeoutSeconds)
    this.authToken = authToken
    this.baseUrl = baseUrl
  }

  getMonitor(onSuccess: Success<MonitorResponseDTO>, onError: HttpError, signal?: AbortSignal): void {
    this.request.get(
      `${this.baseUrl}/${PATH_MONITOR}`,
      this.authToken,
      parseResponse(onSuccess, onError, "Matchmaking | Couldn't parse monitor, update Edgegap SDK.\n"),
      onError,
      undefined,
      signal,
    )
  }

  getBeacons(onSuccess: Success<BeaconsResponseDTO>, onError: HttpError, signal?: AbortSignal): void {
    this.request.get(
      `${this.baseUrl}/${PATH_BEACONS}`,
      this.authToken,
      parseResponse(onSuccess, onError, "Matchmaking | Couldn't parse beacons, update Edgegap SDK.\n"),
      onError,
      undefined,
      signal,
    )
  }

  createGroup<A>(
    group: GroupUpRequestDTO<A>,
    onSuccess: Success<GroupUpResponseDTO>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.post(
      `${this.baseUrl}/${PATH_GROUP_UP}`,
      this.authToken,
      JSON.stringify(group),
      parseResponse(onSuccess, onError, "Couldn't parse group, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  getGroup(
    groupId: string,
    onSuccess: Success<GroupDetailResponse>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.get(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}`,
      this.authToken,
      parseResponse(onSuccess, onError, "Couldn't parse details, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  deleteGroup(groupId: string, onSuccess: Done, onError: HttpError, signal?: AbortSignal): void {
    this.request.delete(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}`,
      this.authToken,
      (_body, response) => onSuccess(response),
      onError,
      undefined,
      signal,
    )
  }

  createGroupMember<A>(
    member: GroupUpRequestDTO<A>,
    groupId: string,
    onSuccess: Success<GroupUpResponseDTO>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.post(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}/members`,
      this.authToken,
      JSON.stringify(member),
      parseResponse(onSuccess, onError, "Couldn't parse member, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  getGroupMember(
    groupId: string,
    memberId: string,
    onSuccess: Success<GroupUpResponseDTO>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.get(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}/members/${memberId}`,
      this.authToken,
      parseResponse(onSuccess, onError, "Couldn't parse details, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  updateGroupMember(
    groupId: string,
    memberId: string,
    isReady: boolean,
    onSuccess: Success<GroupUpResponseDTO>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.patch(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}/members/${memberId}`,
      this.authToken,
      JSON.stringify({ is_ready: isReady }),
      parseResponse(onSuccess, onError, "Couldn't parse member, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  deleteGroupMember(
    groupId: string,
    memberId: string,
    onSuccess: Done,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.delete(
      `${this.baseUrl}/${PATH_GROUP_UP}/${groupId}/members/${memberId}`,
      this.authToken,
      (_body, response) => onSuccess(response),
      onError,
      undefined,
      signal,
    )
  }

  createBackfill<A>(
    backfill: BackfillRequestDTO<A>,
    onSuccess: Success<BackfillResponseDTO<A>>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.post(
      `${this.baseUrl}/${PATH_BACKFILL}`,
      this.authToken,
      JSON.stringify(backfill),
      parseResponse(onSuccess, onError, "Couldn't parse backfill, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  getBackfill<A>(
    backfillId: string,
    onSuccess: Success<BackfillResponseDTO<A>>,
    onError: HttpError,
    signal?: AbortSignal,
  ): void {
    this.request.get(
      `${this.baseUrl}/${PATH_BACKFILL}/${backfillId}`,
      this.authToken,
      parseResponse(onSuccess, onError, "Couldn't parse backfill, consider updating Matchmaking SDK. "),
      onError,
      undefined,
      signal,
    )
  }

  deleteBackfill(backfillId: string, onSuccess: Done, onError: HttpError, signal?: AbortSignal): void {
    this.request.delete(
      `${this.baseUrl}/${PATH_BACKFILL}/${backfillId}`,
      this.authToken,
      (_body, response) => onSuccess(response),
      onError,
      undefined,
      signal,
    )
  }

  dispose(): void {
    this.request.dispose()
  }
}
