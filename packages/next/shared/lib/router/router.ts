// tslint:disable:no-console
import type { ComponentType } from 'react'
import type { DomainLocale } from '../../../server/config'
import type { MittEmitter } from '../mitt'
import type { ParsedUrlQuery } from 'querystring'
import type { RouterEvent } from '../../../client/router'
import type { StyleSheetTuple } from '../../../client/page-loader'
import type { UrlObject } from 'url'
import type PageLoader from '../../../client/page-loader'
import { normalizePathTrailingSlash } from '../../../client/normalize-trailing-slash'
import { removeTrailingSlash } from './utils/remove-trailing-slash'
import {
  getClientBuildManifest,
  isAssetError,
  markAssetError,
} from '../../../client/route-loader'
import { handleClientScriptLoad } from '../../../client/script'
import isError, { getProperError } from '../../../lib/is-error'
import { denormalizePagePath } from '../page-path/denormalize-page-path'
import { normalizeLocalePath } from '../i18n/normalize-locale-path'
import mitt from '../mitt'
import {
  AppContextType,
  getLocationOrigin,
  getURL,
  loadGetInitialProps,
  normalizeRepeatedSlashes,
  NextPageContext,
  ST,
  NEXT_DATA,
  isAbsoluteUrl,
} from '../utils'
import { isDynamicRoute } from './utils/is-dynamic'
import { parseRelativeUrl } from './utils/parse-relative-url'
import { searchParamsToUrlQuery } from './utils/querystring'
import resolveRewrites from './utils/resolve-rewrites'
import { getRouteMatcher } from './utils/route-matcher'
import { getRouteRegex } from './utils/route-regex'
import { formatWithValidation } from './utils/format-url'
import { detectDomainLocale } from '../../../client/detect-domain-locale'
import { parsePath } from './utils/parse-path'
import { addLocale } from '../../../client/add-locale'
import { removeLocale } from '../../../client/remove-locale'
import { removeBasePath } from '../../../client/remove-base-path'
import { addBasePath } from '../../../client/add-base-path'
import { hasBasePath } from '../../../client/has-base-path'
import { getNextPathnameInfo } from './utils/get-next-pathname-info'
import { formatNextPathnameInfo } from './utils/format-next-pathname-info'
import { compareRouterStates } from './utils/compare-states'

declare global {
  interface Window {
    /* prod */
    __NEXT_DATA__: NEXT_DATA
  }
}

interface RouteProperties {
  shallow: boolean
}

interface TransitionOptions {
  shallow?: boolean
  locale?: string | false
  scroll?: boolean
  unstable_skipClientCache?: boolean
}

interface NextHistoryState {
  url: string
  as: string
  options: TransitionOptions
}

export type HistoryState =
  | null
  | { __NA: true; __N?: false }
  | { __N: false; __NA?: false }
  | ({ __NA?: false; __N: true; key: string } & NextHistoryState)

function buildCancellationError() {
  return Object.assign(new Error('Route Cancelled'), {
    cancelled: true,
  })
}

interface MiddlewareEffectParams<T extends FetchDataOutput> {
  fetchData?: () => Promise<T>
  locale?: string
  asPath: string
  router: Router
}

export async function matchesMiddleware<T extends FetchDataOutput>(
  options: MiddlewareEffectParams<T>
): Promise<boolean> {
  const matchers = await Promise.resolve(
    options.router.pageLoader.getMiddleware()
  )
  if (!matchers) return false

  const { pathname: asPathname } = parsePath(options.asPath)
  // remove basePath first since path prefix has to be in the order of `/${basePath}/${locale}`
  const cleanedAs = hasBasePath(asPathname)
    ? removeBasePath(asPathname)
    : asPathname
  const asWithBasePathAndLocale = addBasePath(
    addLocale(cleanedAs, options.locale)
  )

  // Check only path match on client. Matching "has" should be done on server
  // where we can access more info such as headers, HttpOnly cookie, etc.
  return matchers.some((m) =>
    new RegExp(m.regexp).test(asWithBasePathAndLocale)
  )
}

function stripOrigin(url: string) {
  const origin = getLocationOrigin()

  return url.startsWith(origin) ? url.substring(origin.length) : url
}

function omit<T extends { [key: string]: any }, K extends keyof T>(
  object: T,
  keys: K[]
): Omit<T, K> {
  const omitted: { [key: string]: any } = {}
  Object.keys(object).forEach((key) => {
    if (!keys.includes(key as K)) {
      omitted[key] = object[key]
    }
  })
  return omitted as Omit<T, K>
}

/**
 * Detects whether a given url is routable by the Next.js router (browser only).
 */
export function isLocalURL(url: string): boolean {
  // prevent a hydration mismatch on href for url with anchor refs
  if (!isAbsoluteUrl(url)) return true
  try {
    // absolute urls can be local if they are on the same origin
    const locationOrigin = getLocationOrigin()
    const resolved = new URL(url, locationOrigin)
    return resolved.origin === locationOrigin && hasBasePath(resolved.pathname)
  } catch (_) {
    return false
  }
}

export function interpolateAs(
  route: string,
  asPathname: string,
  query: ParsedUrlQuery
) {
  let interpolatedRoute = ''

  const dynamicRegex = getRouteRegex(route)
  const dynamicGroups = dynamicRegex.groups
  const dynamicMatches =
    // Try to match the dynamic route against the asPath
    (asPathname !== route ? getRouteMatcher(dynamicRegex)(asPathname) : '') ||
    // Fall back to reading the values from the href
    // TODO: should this take priority; also need to change in the router.
    query

  interpolatedRoute = route
  const params = Object.keys(dynamicGroups)

  if (
    !params.every((param) => {
      let value = dynamicMatches[param] || ''
      const { repeat, optional } = dynamicGroups[param]

      // support single-level catch-all
      // TODO: more robust handling for user-error (passing `/`)
      let replaced = `[${repeat ? '...' : ''}${param}]`
      if (optional) {
        replaced = `${!value ? '/' : ''}[${replaced}]`
      }
      if (repeat && !Array.isArray(value)) value = [value]

      return (
        (optional || param in dynamicMatches) &&
        // Interpolate group into data URL if present
        (interpolatedRoute =
          interpolatedRoute!.replace(
            replaced,
            repeat
              ? (value as string[])
                  .map(
                    // these values should be fully encoded instead of just
                    // path delimiter escaped since they are being inserted
                    // into the URL and we expect URL encoded segments
                    // when parsing dynamic route params
                    (segment) => encodeURIComponent(segment)
                  )
                  .join('/')
              : encodeURIComponent(value as string)
          ) || '/')
      )
    })
  ) {
    interpolatedRoute = '' // did not satisfy all requirements

    // n.b. We ignore this error because we handle warning for this case in
    // development in the `<Link>` component directly.
  }
  return {
    params,
    result: interpolatedRoute,
  }
}

/**
 * Resolves a given hyperlink with a certain router state (basePath not included).
 * Preserves absolute urls.
 */
export function resolveHref(
  router: NextRouter,
  href: Url,
  resolveAs?: boolean
): string {
  // we use a dummy base url for relative urls
  let base: URL
  let urlAsString = typeof href === 'string' ? href : formatWithValidation(href)

  // repeated slashes and backslashes in the URL are considered
  // invalid and will never match a Next.js page/file
  const urlProtoMatch = urlAsString.match(/^[a-zA-Z]{1,}:\/\//)
  const urlAsStringNoProto = urlProtoMatch
    ? urlAsString.slice(urlProtoMatch[0].length)
    : urlAsString

  const urlParts = urlAsStringNoProto.split('?')

  if ((urlParts[0] || '').match(/(\/\/|\\)/)) {
    console.error(
      `Invalid href passed to next/router: ${urlAsString}, repeated forward-slashes (//) or backslashes \\ are not valid in the href`
    )
    const normalizedUrl = normalizeRepeatedSlashes(urlAsStringNoProto)
    urlAsString = (urlProtoMatch ? urlProtoMatch[0] : '') + normalizedUrl
  }

  // Return because it cannot be routed by the Next.js router
  if (!isLocalURL(urlAsString)) {
    return (resolveAs ? [urlAsString] : urlAsString) as string
  }

  try {
    base = new URL(
      urlAsString.startsWith('#') ? router.asPath : router.pathname,
      'http://n'
    )
  } catch (_) {
    // fallback to / for invalid asPath values e.g. //
    base = new URL('/', 'http://n')
  }
  try {
    const finalUrl = new URL(urlAsString, base)
    finalUrl.pathname = normalizePathTrailingSlash(finalUrl.pathname)
    let interpolatedAs = ''

    if (
      isDynamicRoute(finalUrl.pathname) &&
      finalUrl.searchParams &&
      resolveAs
    ) {
      const query = searchParamsToUrlQuery(finalUrl.searchParams)

      const { result, params } = interpolateAs(
        finalUrl.pathname,
        finalUrl.pathname,
        query
      )

      if (result) {
        interpolatedAs = formatWithValidation({
          pathname: result,
          hash: finalUrl.hash,
          query: omit(query, params),
        })
      }
    }

    // if the origin didn't change, it means we received a relative href
    const resolvedHref =
      finalUrl.origin === base.origin
        ? finalUrl.href.slice(finalUrl.origin.length)
        : finalUrl.href

    return (
      resolveAs ? [resolvedHref, interpolatedAs || resolvedHref] : resolvedHref
    ) as string
  } catch (_) {
    return (resolveAs ? [urlAsString] : urlAsString) as string
  }
}

function prepareUrlAs(router: NextRouter, url: Url, as?: Url) {
  // If url and as provided as an object representation,
  // we'll format them into the string version here.
  let [resolvedHref, resolvedAs] = resolveHref(router, url, true)
  const origin = getLocationOrigin()
  const hrefHadOrigin = resolvedHref.startsWith(origin)
  const asHadOrigin = resolvedAs && resolvedAs.startsWith(origin)

  resolvedHref = stripOrigin(resolvedHref)
  resolvedAs = resolvedAs ? stripOrigin(resolvedAs) : resolvedAs

  const preparedUrl = hrefHadOrigin ? resolvedHref : addBasePath(resolvedHref)
  const preparedAs = as
    ? stripOrigin(resolveHref(router, as))
    : resolvedAs || resolvedHref

  return {
    url: preparedUrl,
    as: asHadOrigin ? preparedAs : addBasePath(preparedAs),
  }
}

function resolveDynamicRoute(pathname: string, pages: string[]) {
  const cleanPathname = removeTrailingSlash(denormalizePagePath(pathname))
  if (cleanPathname === '/404' || cleanPathname === '/_error') {
    return pathname
  }

  // handle resolving href for dynamic routes
  if (!pages.includes(cleanPathname)) {
    // eslint-disable-next-line array-callback-return
    pages.some((page) => {
      if (isDynamicRoute(page) && getRouteRegex(page).re.test(cleanPathname)) {
        pathname = page
        return true
      }
    })
  }
  return removeTrailingSlash(pathname)
}

function getMiddlewareData<T extends FetchDataOutput>(
  source: string,
  response: Response,
  options: MiddlewareEffectParams<T>
) {
  const nextConfig = {
    basePath: options.router.basePath,
    i18n: { locales: options.router.locales },
    trailingSlash: Boolean(process.env.__NEXT_TRAILING_SLASH),
  }
  const rewriteHeader = response.headers.get('x-nextjs-rewrite')

  let rewriteTarget =
    rewriteHeader || response.headers.get('x-nextjs-matched-path')

  const matchedPath = response.headers.get('x-matched-path')

  if (
    matchedPath &&
    !rewriteTarget &&
    !matchedPath.includes('__next_data_catchall') &&
    !matchedPath.includes('/_error') &&
    !matchedPath.includes('/404')
  ) {
    // leverage x-matched-path to detect next.config.js rewrites
    rewriteTarget = matchedPath
  }

  if (rewriteTarget) {
    if (rewriteTarget.startsWith('/')) {
      const parsedRewriteTarget = parseRelativeUrl(rewriteTarget)
      const pathnameInfo = getNextPathnameInfo(parsedRewriteTarget.pathname, {
        nextConfig,
        parseData: true,
      })

      let fsPathname = removeTrailingSlash(pathnameInfo.pathname)
      return Promise.all([
        options.router.pageLoader.getPageList(),
        getClientBuildManifest(),
      ]).then(([pages, { __rewrites: rewrites }]: any) => {
        let as = addLocale(pathnameInfo.pathname, pathnameInfo.locale)

        if (
          isDynamicRoute(as) ||
          (!rewriteHeader &&
            pages.includes(
              normalizeLocalePath(removeBasePath(as), options.router.locales)
                .pathname
            ))
        ) {
          const parsedSource = getNextPathnameInfo(
            parseRelativeUrl(source).pathname,
            { parseData: true }
          )

          as = addBasePath(parsedSource.pathname)
          parsedRewriteTarget.pathname = as
        }

        if (process.env.__NEXT_HAS_REWRITES) {
          const result = resolveRewrites(
            as,
            pages,
            rewrites,
            parsedRewriteTarget.query,
            (path: string) => resolveDynamicRoute(path, pages),
            options.router.locales
          )

          if (result.matchedPage) {
            parsedRewriteTarget.pathname = result.parsedAs.pathname
            as = parsedRewriteTarget.pathname
            Object.assign(parsedRewriteTarget.query, result.parsedAs.query)
          }
        } else if (!pages.includes(fsPathname)) {
          const resolvedPathname = resolveDynamicRoute(fsPathname, pages)

          if (resolvedPathname !== fsPathname) {
            fsPathname = resolvedPathname
          }
        }

        const resolvedHref = !pages.includes(fsPathname)
          ? resolveDynamicRoute(
              normalizeLocalePath(
                removeBasePath(parsedRewriteTarget.pathname),
                options.router.locales
              ).pathname,
              pages
            )
          : fsPathname

        if (isDynamicRoute(resolvedHref)) {
          const matches = getRouteMatcher(getRouteRegex(resolvedHref))(as)
          Object.assign(parsedRewriteTarget.query, matches || {})
        }

        return {
          type: 'rewrite' as const,
          parsedAs: parsedRewriteTarget,
          resolvedHref,
        }
      })
    }

    const src = parsePath(source)
    const pathname = formatNextPathnameInfo({
      ...getNextPathnameInfo(src.pathname, { nextConfig, parseData: true }),
      defaultLocale: options.router.defaultLocale,
      buildId: '',
    })

    return Promise.resolve({
      type: 'redirect-external' as const,
      destination: `${pathname}${src.query}${src.hash}`,
    })
  }

  const redirectTarget = response.headers.get('x-nextjs-redirect')

  if (redirectTarget) {
    if (redirectTarget.startsWith('/')) {
      const src = parsePath(redirectTarget)
      const pathname = formatNextPathnameInfo({
        ...getNextPathnameInfo(src.pathname, { nextConfig, parseData: true }),
        defaultLocale: options.router.defaultLocale,
        buildId: '',
      })

      return Promise.resolve({
        type: 'redirect-internal' as const,
        newAs: `${pathname}${src.query}${src.hash}`,
        newUrl: `${pathname}${src.query}${src.hash}`,
      })
    }

    return Promise.resolve({
      type: 'redirect-external' as const,
      destination: redirectTarget,
    })
  }

  return Promise.resolve({ type: 'next' as const })
}

function withMiddlewareEffects<T extends FetchDataOutput>(
  options: MiddlewareEffectParams<T>
) {
  return matchesMiddleware(options).then((matches) => {
    if (matches && options.fetchData) {
      return options
        .fetchData()
        .then((data) =>
          getMiddlewareData(data.dataHref, data.response, options).then(
            (effect) => ({
              dataHref: data.dataHref,
              json: data.json,
              response: data.response,
              text: data.text,
              effect,
            })
          )
        )
        .catch((_err) => {
          /**
           * TODO: Revisit this in the future.
           * For now we will not consider middleware data errors to be fatal.
           * maybe we should revisit in the future.
           */
          return null
        })
    }

    return null
  })
}

type Url = UrlObject | string

export type BaseRouter = {
  route: string
  pathname: string
  query: ParsedUrlQuery
  asPath: string
  basePath: string
  locale?: string | undefined
  locales?: string[] | undefined
  defaultLocale?: string | undefined
  domainLocales?: DomainLocale[] | undefined
  isLocaleDomain: boolean
}

export type NextRouter = BaseRouter &
  Pick<
    Router,
    | 'push'
    | 'replace'
    | 'reload'
    | 'back'
    | 'prefetch'
    | 'beforePopState'
    | 'events'
    | 'isFallback'
    | 'isReady'
    | 'isPreview'
  >

export type PrefetchOptions = {
  priority?: boolean
  locale?: string | false
  unstable_skipClientCache?: boolean
}

export type PrivateRouteInfo =
  | (Omit<CompletePrivateRouteInfo, 'styleSheets'> & { initial: true })
  | CompletePrivateRouteInfo

export type CompletePrivateRouteInfo = {
  Component: ComponentType
  styleSheets: StyleSheetTuple[]
  __N_SSG?: boolean
  __N_SSP?: boolean
  __N_RSC?: boolean
  props?: Record<string, any>
  err?: Error
  error?: any
  route?: string
  resolvedAs?: string
  query?: ParsedUrlQuery
}

export type AppProps = Pick<CompletePrivateRouteInfo, 'Component' | 'err'> & {
  router: Router
} & Record<string, any>
export type AppComponent = ComponentType<AppProps>

type Subscription = (
  data: PrivateRouteInfo,
  App: AppComponent,
  resetScroll: { x: number; y: number } | null
) => Promise<void>

type BeforePopStateCallback = (state: NextHistoryState) => boolean

type ComponentLoadCancel = (() => void) | null

type HistoryMethod = 'replaceState' | 'pushState'

const manualScrollRestoration =
  process.env.__NEXT_SCROLL_RESTORATION &&
  typeof window !== 'undefined' &&
  'scrollRestoration' in window.history &&
  !!(function () {
    try {
      let v = '__next'
      // eslint-disable-next-line no-sequences
      return sessionStorage.setItem(v, v), sessionStorage.removeItem(v), true
    } catch (n) {}
  })()

const SSG_DATA_NOT_FOUND = Symbol('SSG_DATA_NOT_FOUND')

function fetchRetry(
  url: string,
  attempts: number,
  options: Pick<RequestInit, 'method' | 'headers'>
): Promise<Response> {
  return fetch(url, {
    // Cookies are required to be present for Next.js' SSG "Preview Mode".
    // Cookies may also be required for `getServerSideProps`.
    //
    // > `fetch` won’t send cookies, unless you set the credentials init
    // > option.
    // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
    //
    // > For maximum browser compatibility when it comes to sending &
    // > receiving cookies, always supply the `credentials: 'same-origin'`
    // > option instead of relying on the default.
    // https://github.com/github/fetch#caveats
    credentials: 'same-origin',
    method: options.method || 'GET',
    headers: Object.assign({}, options.headers, {
      'x-nextjs-data': '1',
    }),
  }).then((response) => {
    return !response.ok && attempts > 1 && response.status >= 500
      ? fetchRetry(url, attempts - 1, options)
      : response
  })
}

const backgroundCache: Record<string, Promise<any>> = {}

interface FetchDataOutput {
  dataHref: string
  json: Record<string, any> | null
  response: Response
  text: string
}

interface FetchNextDataParams {
  dataHref: string
  isServerRender: boolean
  parseJSON: boolean | undefined
  hasMiddleware?: boolean
  inflightCache: NextDataCache
  persistCache: boolean
  isPrefetch: boolean
  isBackground?: boolean
  unstable_skipClientCache?: boolean
}

function tryToParseAsJSON(text: string) {
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

function fetchNextData({
  dataHref,
  inflightCache,
  isPrefetch,
  hasMiddleware,
  isServerRender,
  parseJSON,
  persistCache,
  isBackground,
  unstable_skipClientCache,
}: FetchNextDataParams): Promise<FetchDataOutput> {
  const { href: cacheKey } = new URL(dataHref, window.location.href)
  const getData = (params?: { method?: 'HEAD' | 'GET' }) =>
    fetchRetry(dataHref, isServerRender ? 3 : 1, {
      headers: isPrefetch ? { purpose: 'prefetch' } : {},
      method: params?.method ?? 'GET',
    })
      .then((response) => {
        if (response.ok && params?.method === 'HEAD') {
          return { dataHref, response, text: '', json: {} }
        }

        return response.text().then((text) => {
          if (!response.ok) {
            /**
             * When the data response is a redirect because of a middleware
             * we do not consider it an error. The headers must bring the
             * mapped location.
             * TODO: Change the status code in the handler.
             */
            if (
              hasMiddleware &&
              [301, 302, 307, 308].includes(response.status)
            ) {
              return { dataHref, response, text, json: {} }
            }

            if (!hasMiddleware && response.status === 404) {
              if (tryToParseAsJSON(text)?.notFound) {
                return {
                  dataHref,
                  json: { notFound: SSG_DATA_NOT_FOUND },
                  response,
                  text,
                }
              }
            }

            const error = new Error(`Failed to load static props`)

            /**
             * We should only trigger a server-side transition if this was
             * caused on a client-side transition. Otherwise, we'd get into
             * an infinite loop.
             */
            if (!isServerRender) {
              markAssetError(error)
            }

            throw error
          }

          return {
            dataHref,
            json: parseJSON ? tryToParseAsJSON(text) : null,
            response,
            text,
          }
        })
      })
      .then((data) => {
        if (
          !persistCache ||
          process.env.NODE_ENV !== 'production' ||
          data.response.headers.get('x-middleware-cache') === 'no-cache'
        ) {
          delete inflightCache[cacheKey]
        }
        return data
      })
      .catch((err) => {
        delete inflightCache[cacheKey]
        throw err
      })

  // when skipping client cache we wait to update
  // inflight cache until successful data response
  // this allows racing click event with fetching newer data
  // without blocking navigation when stale data is available
  if (unstable_skipClientCache && persistCache) {
    return getData({}).then((data) => {
      inflightCache[cacheKey] = Promise.resolve(data)
      return data
    })
  }

  if (inflightCache[cacheKey] !== undefined) {
    return inflightCache[cacheKey]
  }
  return (inflightCache[cacheKey] = getData(
    isBackground ? { method: 'HEAD' } : {}
  ))
}

interface NextDataCache {
  [asPath: string]: Promise<FetchDataOutput>
}

export function createKey() {
  return Math.random().toString(36).slice(2, 10)
}

function handleHardNavigation({
  url,
  router,
}: {
  url: string
  router: Router
}) {
  // ensure we don't trigger a hard navigation to the same
  // URL as this can end up with an infinite refresh
  if (url === addBasePath(addLocale(router.asPath, router.locale))) {
    throw new Error(
      `Invariant: attempted to hard navigate to the same URL ${url} ${location.href}`
    )
  }
  window.location.href = url
}

const getCancelledHandler = ({
  route,
  router,
}: {
  route: string
  router: Router
}) => {
  let cancelled = false
  const cancel = (router.clc = () => {
    cancelled = true
  })

  const handleCancelled = () => {
    if (cancelled) {
      const error: any = new Error(
        `Abort fetching component for route: "${route}"`
      )
      error.cancelled = true
      throw error
    }

    if (cancel === router.clc) {
      router.clc = null
    }
  }
  return handleCancelled
}

export default class Router implements BaseRouter {
  basePath: string

  /**
   * Map of all components loaded in `Router`
   */
  components: { [pathname: string]: PrivateRouteInfo }
  // Server Data Cache
  sdc: NextDataCache = {}

  sub: Subscription
  clc: ComponentLoadCancel
  pageLoader: PageLoader
  _bps: BeforePopStateCallback | undefined
  events: MittEmitter<RouterEvent>
  _wrapApp: (App: AppComponent) => any
  isSsr: boolean
  _inFlightRoute?: string | undefined
  _shallow?: boolean | undefined
  locales?: string[] | undefined
  defaultLocale?: string | undefined
  domainLocales?: DomainLocale[] | undefined
  isReady: boolean
  isLocaleDomain: boolean
  isFirstPopStateEvent = true
  _initialMatchesMiddlewarePromise: Promise<boolean>

  private state: Readonly<{
    route: string
    pathname: string
    query: ParsedUrlQuery
    asPath: string
    locale: string | undefined
    isFallback: boolean
    isPreview: boolean
  }>

  private _key: string = createKey()

  static events: MittEmitter<RouterEvent> = mitt()

  constructor(
    pathname: string,
    query: ParsedUrlQuery,
    as: string,
    {
      initialProps,
      pageLoader,
      App,
      wrapApp,
      Component,
      err,
      subscription,
      isFallback,
      locale,
      locales,
      defaultLocale,
      domainLocales,
      isPreview,
      isRsc,
    }: {
      subscription: Subscription
      initialProps: any
      pageLoader: any
      Component: ComponentType
      App: AppComponent
      wrapApp: (WrapAppComponent: AppComponent) => any
      err?: Error
      isFallback: boolean
      locale?: string
      locales?: string[]
      defaultLocale?: string
      domainLocales?: DomainLocale[]
      isPreview?: boolean
      isRsc?: boolean
    }
  ) {
    // represents the current component key
    const route = removeTrailingSlash(pathname)

    // set up the component cache (by route keys)
    this.components = {}
    // We should not keep the cache, if there's an error
    // Otherwise, this cause issues when when going back and
    // come again to the errored page.
    if (pathname !== '/_error') {
      this.components[route] = {
        Component,
        initial: true,
        props: initialProps,
        err,
        __N_SSG: initialProps && initialProps.__N_SSG,
        __N_SSP: initialProps && initialProps.__N_SSP,
        __N_RSC: !!isRsc,
      }
    }

    this.components['/_app'] = {
      Component: App as ComponentType,
      styleSheets: [
        /* /_app does not need its stylesheets managed */
      ],
    }

    // Backwards compat for Router.router.events
    // TODO: Should be remove the following major version as it was never documented
    this.events = Router.events

    this.pageLoader = pageLoader
    // if auto prerendered and dynamic route wait to update asPath
    // until after mount to prevent hydration mismatch
    const autoExportDynamic =
      isDynamicRoute(pathname) && self.__NEXT_DATA__.autoExport

    this.basePath = process.env.__NEXT_ROUTER_BASEPATH || ''
    this.sub = subscription
    this.clc = null
    this._wrapApp = wrapApp
    // make sure to ignore extra popState in safari on navigating
    // back from external site
    this.isSsr = true
    this.isLocaleDomain = false
    this.isReady = !!(
      self.__NEXT_DATA__.gssp ||
      self.__NEXT_DATA__.gip ||
      (self.__NEXT_DATA__.appGip && !self.__NEXT_DATA__.gsp) ||
      (!autoExportDynamic &&
        !self.location.search &&
        !process.env.__NEXT_HAS_REWRITES)
    )

    if (process.env.__NEXT_I18N_SUPPORT) {
      this.locales = locales
      this.defaultLocale = defaultLocale
      this.domainLocales = domainLocales
      this.isLocaleDomain = !!detectDomainLocale(
        domainLocales,
        self.location.hostname
      )
    }

    this.state = {
      route,
      pathname,
      query,
      asPath: autoExportDynamic ? pathname : as,
      isPreview: !!isPreview,
      locale: process.env.__NEXT_I18N_SUPPORT ? locale : undefined,
      isFallback,
    }

    this._initialMatchesMiddlewarePromise = Promise.resolve(false)

    if (typeof window !== 'undefined') {
      // make sure "as" doesn't start with double slashes or else it can
      // throw an error as it's considered invalid
      if (!as.startsWith('//')) {
        // in order for `e.state` to work on the `onpopstate` event
        // we have to register the initial route upon initialization
        const options: TransitionOptions = { locale }
        const asPath = getURL()

        this._initialMatchesMiddlewarePromise = matchesMiddleware({
          router: this,
          locale,
          asPath,
        }).then((matches) => {
          // if middleware matches we leave resolving to the change function
          // as the server needs to resolve for correct priority
          ;(options as any)._shouldResolveHref = as !== pathname

          this.changeState(
            'replaceState',
            matches
              ? asPath
              : formatWithValidation({
                  pathname: addBasePath(pathname),
                  query,
                }),
            asPath,
            options
          )
          return matches
        })
      }

      window.addEventListener('popstate', this.onPopState)

      // enable custom scroll restoration handling when available
      // otherwise fallback to browser's default handling
      if (process.env.__NEXT_SCROLL_RESTORATION) {
        if (manualScrollRestoration) {
          window.history.scrollRestoration = 'manual'
        }
      }
    }
  }

  onPopState = (e: PopStateEvent): void => {
    const { isFirstPopStateEvent } = this
    this.isFirstPopStateEvent = false

    const state = e.state as HistoryState

    if (!state) {
      // We get state as undefined for two reasons.
      //  1. With older safari (< 8) and older chrome (< 34)
      //  2. When the URL changed with #
      //
      // In the both cases, we don't need to proceed and change the route.
      // (as it's already changed)
      // But we can simply replace the state with the new changes.
      // Actually, for (1) we don't need to nothing. But it's hard to detect that event.
      // So, doing the following for (1) does no harm.
      const { pathname, query } = this
      this.changeState(
        'replaceState',
        formatWithValidation({ pathname: addBasePath(pathname), query }),
        getURL()
      )
      return
    }

    // __NA is used to identify if the history entry can be handled by the app-router.
    if (state.__NA) {
      window.location.reload()
      return
    }

    if (!state.__N) {
      return
    }

    // Safari fires popstateevent when reopening the browser.
    if (
      isFirstPopStateEvent &&
      this.locale === state.options.locale &&
      state.as === this.asPath
    ) {
      return
    }

    let forcedScroll: { x: number; y: number } | undefined
    const { url, as, options, key } = state
    if (process.env.__NEXT_SCROLL_RESTORATION) {
      if (manualScrollRestoration) {
        if (this._key !== key) {
          // Snapshot current scroll position:
          try {
            sessionStorage.setItem(
              '__next_scroll_' + this._key,
              JSON.stringify({ x: self.pageXOffset, y: self.pageYOffset })
            )
          } catch {}

          // Restore old scroll position:
          try {
            const v = sessionStorage.getItem('__next_scroll_' + key)
            forcedScroll = JSON.parse(v!)
          } catch {
            forcedScroll = { x: 0, y: 0 }
          }
        }
      }
    }
    this._key = key

    const { pathname } = parseRelativeUrl(url)

    // Make sure we don't re-render on initial load,
    // can be caused by navigating back from an external site
    if (
      this.isSsr &&
      as === addBasePath(this.asPath) &&
      pathname === addBasePath(this.pathname)
    ) {
      return
    }

    // If the downstream application returns falsy, return.
    // They will then be responsible for handling the event.
    if (this._bps && !this._bps(state)) {
      return
    }

    this.change(
      'replaceState',
      url,
      as,
      Object.assign<{}, TransitionOptions, TransitionOptions>({}, options, {
        shallow: options.shallow && this._shallow,
        locale: options.locale || this.defaultLocale,
        // @ts-ignore internal value not exposed on types
        _h: 0,
      }),
      forcedScroll
    )
  }

  reload(): void {
    window.location.reload()
  }

  /**
   * Go back in history
   */
  back() {
    window.history.back()
  }

  /**
   * Performs a `pushState` with arguments
   * @param url of the route
   * @param as masks `url` for the browser
   * @param options object you can define `shallow` and other options
   */
  push(url: Url, as?: Url, options: TransitionOptions = {}) {
    if (process.env.__NEXT_SCROLL_RESTORATION) {
      // TODO: remove in the future when we update history before route change
      // is complete, as the popstate event should handle this capture.
      if (manualScrollRestoration) {
        try {
          // Snapshot scroll position right before navigating to a new page:
          sessionStorage.setItem(
            '__next_scroll_' + this._key,
            JSON.stringify({ x: self.pageXOffset, y: self.pageYOffset })
          )
        } catch {}
      }
    }
    ;({ url, as } = prepareUrlAs(this, url, as))
    return this.change('pushState', url, as, options)
  }

  /**
   * Performs a `replaceState` with arguments
   * @param url of the route
   * @param as masks `url` for the browser
   * @param options object you can define `shallow` and other options
   */
  replace(url: Url, as?: Url, options: TransitionOptions = {}) {
    ;({ url, as } = prepareUrlAs(this, url, as))
    return this.change('replaceState', url, as, options)
  }

  private async change(
    method: HistoryMethod,
    url: string,
    as: string,
    options: TransitionOptions,
    forcedScroll?: { x: number; y: number }
  ): Promise<boolean> {
    if (!isLocalURL(url)) {
      handleHardNavigation({ url, router: this })
      return false
    }
    // WARNING: `_h` is an internal option for handing Next.js client-side
    // hydration. Your app should _never_ use this property. It may change at
    // any time without notice.
    const isQueryUpdating = (options as any)._h
    const shouldResolveHref =
      isQueryUpdating ||
      (options as any)._shouldResolveHref ||
      parsePath(url).pathname === parsePath(as).pathname

    const nextState = {
      ...this.state,
    }

    // for static pages with query params in the URL we delay
    // marking the router ready until after the query is updated
    // or a navigation has occurred
    const readyStateChange = this.isReady !== true
    this.isReady = true
    const isSsr = this.isSsr

    if (!isQueryUpdating) {
      this.isSsr = false
    }

    // if a route transition is already in progress before
    // the query updating is triggered ignore query updating
    if (isQueryUpdating && this.clc) {
      return false
    }

    const prevLocale = nextState.locale

    if (process.env.__NEXT_I18N_SUPPORT) {
      nextState.locale =
        options.locale === false
          ? this.defaultLocale
          : options.locale || nextState.locale

      if (typeof options.locale === 'undefined') {
        options.locale = nextState.locale
      }

      const parsedAs = parseRelativeUrl(
        hasBasePath(as) ? removeBasePath(as) : as
      )
      const localePathResult = normalizeLocalePath(
        parsedAs.pathname,
        this.locales
      )

      if (localePathResult.detectedLocale) {
        nextState.locale = localePathResult.detectedLocale
        parsedAs.pathname = addBasePath(parsedAs.pathname)
        as = formatWithValidation(parsedAs)
        url = addBasePath(
          normalizeLocalePath(
            hasBasePath(url) ? removeBasePath(url) : url,
            this.locales
          ).pathname
        )
      }
      let didNavigate = false

      // we need to wrap this in the env check again since regenerator runtime
      // moves this on its own due to the return
      if (process.env.__NEXT_I18N_SUPPORT) {
        // if the locale isn't configured hard navigate to show 404 page
        if (!this.locales?.includes(nextState.locale!)) {
          parsedAs.pathname = addLocale(parsedAs.pathname, nextState.locale)
          handleHardNavigation({
            url: formatWithValidation(parsedAs),
            router: this,
          })
          // this was previously a return but was removed in favor
          // of better dead code elimination with regenerator runtime
          didNavigate = true
        }
      }

      const detectedDomain = detectDomainLocale(
        this.domainLocales,
        undefined,
        nextState.locale
      )

      // we need to wrap this in the env check again since regenerator runtime
      // moves this on its own due to the return
      if (process.env.__NEXT_I18N_SUPPORT) {
        // if we are navigating to a domain locale ensure we redirect to the
        // correct domain
        if (
          !didNavigate &&
          detectedDomain &&
          this.isLocaleDomain &&
          self.location.hostname !== detectedDomain.domain
        ) {
          const asNoBasePath = removeBasePath(as)
          handleHardNavigation({
            url: `http${detectedDomain.http ? '' : 's'}://${
              detectedDomain.domain
            }${addBasePath(
              `${
                nextState.locale === detectedDomain.defaultLocale
                  ? ''
                  : `/${nextState.locale}`
              }${asNoBasePath === '/' ? '' : asNoBasePath}` || '/'
            )}`,
            router: this,
          })
          // this was previously a return but was removed in favor
          // of better dead code elimination with regenerator runtime
          didNavigate = true
        }
      }

      if (didNavigate) {
        return new Promise(() => {})
      }
    }

    // marking route changes as a navigation start entry
    if (ST) {
      performance.mark('routeChange')
    }

    const { shallow = false, scroll = true } = options
    const routeProps = { shallow }

    if (this._inFlightRoute && this.clc) {
      if (!isSsr) {
        Router.events.emit(
          'routeChangeError',
          buildCancellationError(),
          this._inFlightRoute,
          routeProps
        )
      }
      this.clc()
      this.clc = null
    }

    as = addBasePath(
      addLocale(
        hasBasePath(as) ? removeBasePath(as) : as,
        options.locale,
        this.defaultLocale
      )
    )
    const cleanedAs = removeLocale(
      hasBasePath(as) ? removeBasePath(as) : as,
      nextState.locale
    )
    this._inFlightRoute = as

    const localeChange = prevLocale !== nextState.locale

    // If the url change is only related to a hash change
    // We should not proceed. We should only change the state.

    if (!isQueryUpdating && this.onlyAHashChange(cleanedAs) && !localeChange) {
      nextState.asPath = cleanedAs
      Router.events.emit('hashChangeStart', as, routeProps)
      // TODO: do we need the resolved href when only a hash change?
      this.changeState(method, url, as, {
        ...options,
        scroll: false,
      })
      if (scroll) {
        this.scrollToHash(cleanedAs)
      }
      try {
        await this.set(nextState, this.components[nextState.route], null)
      } catch (err) {
        if (isError(err) && err.cancelled) {
          Router.events.emit('routeChangeError', err, cleanedAs, routeProps)
        }
        throw err
      }

      Router.events.emit('hashChangeComplete', as, routeProps)
      return true
    }

    let parsed = parseRelativeUrl(url)
    let { pathname, query } = parsed

    // The build manifest needs to be loaded before auto-static dynamic pages
    // get their query parameters to allow ensuring they can be parsed properly
    // when rewritten to
    let pages: string[], rewrites: any
    try {
      ;[pages, { __rewrites: rewrites }] = await Promise.all([
        this.pageLoader.getPageList(),
        getClientBuildManifest(),
        this.pageLoader.getMiddleware(),
      ])
    } catch (err) {
      // If we fail to resolve the page list or client-build manifest, we must
      // do a server-side transition:
      handleHardNavigation({ url: as, router: this })
      return false
    }

    // If asked to change the current URL we should reload the current page
    // (not location.reload() but reload getInitialProps and other Next.js stuffs)
    // We also need to set the method = replaceState always
    // as this should not go into the history (That's how browsers work)
    // We should compare the new asPath to the current asPath, not the url
    if (!this.urlIsNew(cleanedAs) && !localeChange) {
      method = 'replaceState'
    }

    // we need to resolve the as value using rewrites for dynamic SSG
    // pages to allow building the data URL correctly
    let resolvedAs = as

    // url and as should always be prefixed with basePath by this
    // point by either next/link or router.push/replace so strip the
    // basePath from the pathname to match the pages dir 1-to-1
    pathname = pathname
      ? removeTrailingSlash(removeBasePath(pathname))
      : pathname

    // we don't attempt resolve asPath when we need to execute
    // middleware as the resolving will occur server-side
    const isMiddlewareMatch = await matchesMiddleware({
      asPath: as,
      locale: nextState.locale,
      router: this,
    })

    if (options.shallow && isMiddlewareMatch) {
      pathname = this.pathname
    }

    if (shouldResolveHref && pathname !== '/_error') {
      ;(options as any)._shouldResolveHref = true

      if (process.env.__NEXT_HAS_REWRITES && as.startsWith('/')) {
        const rewritesResult = resolveRewrites(
          addBasePath(addLocale(cleanedAs, nextState.locale), true),
          pages,
          rewrites,
          query,
          (p: string) => resolveDynamicRoute(p, pages),
          this.locales
        )

        if (rewritesResult.externalDest) {
          handleHardNavigation({ url: as, router: this })
          return true
        }
        if (!isMiddlewareMatch) {
          resolvedAs = rewritesResult.asPath
        }

        if (rewritesResult.matchedPage && rewritesResult.resolvedHref) {
          // if this directly matches a page we need to update the href to
          // allow the correct page chunk to be loaded
          pathname = rewritesResult.resolvedHref
          parsed.pathname = addBasePath(pathname)

          if (!isMiddlewareMatch) {
            url = formatWithValidation(parsed)
          }
        }
      } else {
        parsed.pathname = resolveDynamicRoute(pathname, pages)

        if (parsed.pathname !== pathname) {
          pathname = parsed.pathname
          parsed.pathname = addBasePath(pathname)

          if (!isMiddlewareMatch) {
            url = formatWithValidation(parsed)
          }
        }
      }
    }

    if (!isLocalURL(as)) {
      if (process.env.NODE_ENV !== 'production') {
        throw new Error(
          `Invalid href: "${url}" and as: "${as}", received relative href and external as` +
            `\nSee more info: https://nextjs.org/docs/messages/invalid-relative-url-external-as`
        )
      }
      handleHardNavigation({ url: as, router: this })
      return false
    }

    resolvedAs = removeLocale(removeBasePath(resolvedAs), nextState.locale)

    let route = removeTrailingSlash(pathname)
    let routeMatch: { [paramName: string]: string | string[] } | false = false

    if (isDynamicRoute(route)) {
      const parsedAs = parseRelativeUrl(resolvedAs)
      const asPathname = parsedAs.pathname

      const routeRegex = getRouteRegex(route)
      routeMatch = getRouteMatcher(routeRegex)(asPathname)
      const shouldInterpolate = route === asPathname
      const interpolatedAs = shouldInterpolate
        ? interpolateAs(route, asPathname, query)
        : ({} as { result: undefined; params: undefined })

      if (!routeMatch || (shouldInterpolate && !interpolatedAs.result)) {
        const missingParams = Object.keys(routeRegex.groups).filter(
          (param) => !query[param]
        )

        if (missingParams.length > 0 && !isMiddlewareMatch) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `${
                shouldInterpolate
                  ? `Interpolating href`
                  : `Mismatching \`as\` and \`href\``
              } failed to manually provide ` +
                `the params: ${missingParams.join(
                  ', '
                )} in the \`href\`'s \`query\``
            )
          }

          throw new Error(
            (shouldInterpolate
              ? `The provided \`href\` (${url}) value is missing query values (${missingParams.join(
                  ', '
                )}) to be interpolated properly. `
              : `The provided \`as\` value (${asPathname}) is incompatible with the \`href\` value (${route}). `) +
              `Read more: https://nextjs.org/docs/messages/${
                shouldInterpolate
                  ? 'href-interpolation-failed'
                  : 'incompatible-href-as'
              }`
          )
        }
      } else if (shouldInterpolate) {
        as = formatWithValidation(
          Object.assign({}, parsedAs, {
            pathname: interpolatedAs.result,
            query: omit(query, interpolatedAs.params!),
          })
        )
      } else {
        // Merge params into `query`, overwriting any specified in search
        Object.assign(query, routeMatch)
      }
    }

    if (!isQueryUpdating) {
      Router.events.emit('routeChangeStart', as, routeProps)
    }

    try {
      let routeInfo = await this.getRouteInfo({
        route,
        pathname,
        query,
        as,
        resolvedAs,
        routeProps,
        locale: nextState.locale,
        isPreview: nextState.isPreview,
        hasMiddleware: isMiddlewareMatch,
      })

      if ('route' in routeInfo && isMiddlewareMatch) {
        pathname = routeInfo.route || route
        route = pathname

        if (!routeProps.shallow) {
          query = Object.assign({}, routeInfo.query || {}, query)
        }

        if (routeMatch && pathname !== parsed.pathname) {
          Object.keys(routeMatch).forEach((key) => {
            if (routeMatch && query[key] === routeMatch[key]) {
              delete query[key]
            }
          })
        }

        if (isDynamicRoute(pathname)) {
          const prefixedAs =
            !routeProps.shallow && routeInfo.resolvedAs
              ? routeInfo.resolvedAs
              : addBasePath(
                  addLocale(
                    new URL(as, location.href).pathname,
                    nextState.locale
                  ),
                  true
                )

          let rewriteAs = prefixedAs

          if (hasBasePath(rewriteAs)) {
            rewriteAs = removeBasePath(rewriteAs)
          }

          if (process.env.__NEXT_I18N_SUPPORT) {
            const localeResult = normalizeLocalePath(rewriteAs, this.locales)
            nextState.locale = localeResult.detectedLocale || nextState.locale
            rewriteAs = localeResult.pathname
          }
          const routeRegex = getRouteRegex(pathname)
          const curRouteMatch = getRouteMatcher(routeRegex)(rewriteAs)

          if (curRouteMatch) {
            Object.assign(query, curRouteMatch)
          }
        }
      }

      // If the routeInfo brings a redirect we simply apply it.
      if ('type' in routeInfo) {
        if (routeInfo.type === 'redirect-internal') {
          return this.change(method, routeInfo.newUrl, routeInfo.newAs, options)
        } else {
          handleHardNavigation({ url: routeInfo.destination, router: this })
          return new Promise(() => {})
        }
      }

      let { error, props, __N_SSG, __N_SSP } = routeInfo

      const component: any = routeInfo.Component
      if (component && component.unstable_scriptLoader) {
        const scripts = [].concat(component.unstable_scriptLoader())

        scripts.forEach((script: any) => {
          handleClientScriptLoad(script.props)
        })
      }

      // handle redirect on client-transition
      if ((__N_SSG || __N_SSP) && props) {
        if (props.pageProps && props.pageProps.__N_REDIRECT) {
          // Use the destination from redirect without adding locale
          options.locale = false

          const destination = props.pageProps.__N_REDIRECT

          // check if destination is internal (resolves to a page) and attempt
          // client-navigation if it is falling back to hard navigation if
          // it's not
          if (
            destination.startsWith('/') &&
            props.pageProps.__N_REDIRECT_BASE_PATH !== false
          ) {
            const parsedHref = parseRelativeUrl(destination)
            parsedHref.pathname = resolveDynamicRoute(
              parsedHref.pathname,
              pages
            )

            const { url: newUrl, as: newAs } = prepareUrlAs(
              this,
              destination,
              destination
            )
            return this.change(method, newUrl, newAs, options)
          }
          handleHardNavigation({ url: destination, router: this })
          return new Promise(() => {})
        }

        nextState.isPreview = !!props.__N_PREVIEW

        // handle SSG data 404
        if (props.notFound === SSG_DATA_NOT_FOUND) {
          let notFoundRoute

          try {
            await this.fetchComponent('/404')
            notFoundRoute = '/404'
          } catch (_) {
            notFoundRoute = '/_error'
          }

          routeInfo = await this.getRouteInfo({
            route: notFoundRoute,
            pathname: notFoundRoute,
            query,
            as,
            resolvedAs,
            routeProps: { shallow: false },
            locale: nextState.locale,
            isPreview: nextState.isPreview,
          })

          if ('type' in routeInfo) {
            throw new Error(`Unexpected middleware effect on /404`)
          }
        }
      }

      Router.events.emit('beforeHistoryChange', as, routeProps)
      this.changeState(method, url, as, options)

      if (
        isQueryUpdating &&
        pathname === '/_error' &&
        self.__NEXT_DATA__.props?.pageProps?.statusCode === 500 &&
        props?.pageProps
      ) {
        // ensure statusCode is still correct for static 500 page
        // when updating query information
        props.pageProps.statusCode = 500
      }

      // shallow routing is only allowed for same page URL changes.
      const isValidShallowRoute =
        options.shallow && nextState.route === (routeInfo.route ?? route)

      const shouldScroll =
        options.scroll ?? (!(options as any)._h && !isValidShallowRoute)
      const resetScroll = shouldScroll ? { x: 0, y: 0 } : null

      // the new state that the router gonna set
      const upcomingRouterState = {
        ...nextState,
        route,
        pathname,
        query,
        asPath: cleanedAs,
        isFallback: false,
      }
      const upcomingScrollState = forcedScroll ?? resetScroll

      // for query updates we can skip it if the state is unchanged and we don't
      // need to scroll
      // https://github.com/vercel/next.js/issues/37139
      const canSkipUpdating =
        (options as any)._h &&
        !upcomingScrollState &&
        !readyStateChange &&
        !localeChange &&
        compareRouterStates(upcomingRouterState, this.state)

      if (!canSkipUpdating) {
        await this.set(
          upcomingRouterState,
          routeInfo,
          upcomingScrollState
        ).catch((e) => {
          if (e.cancelled) error = error || e
          else throw e
        })

        if (error) {
          if (!isQueryUpdating) {
            Router.events.emit('routeChangeError', error, cleanedAs, routeProps)
          }
          throw error
        }

        if (process.env.__NEXT_I18N_SUPPORT) {
          if (nextState.locale) {
            document.documentElement.lang = nextState.locale
          }
        }

        if (!isQueryUpdating) {
          Router.events.emit('routeChangeComplete', as, routeProps)
        }

        // A hash mark # is the optional last part of a URL
        const hashRegex = /#.+$/
        if (shouldScroll && hashRegex.test(as)) {
          this.scrollToHash(as)
        }
      }

      return true
    } catch (err) {
      if (isError(err) && err.cancelled) {
        return false
      }
      throw err
    }
  }

  changeState(
    method: HistoryMethod,
    url: string,
    as: string,
    options: TransitionOptions = {}
  ): void {
    if (process.env.NODE_ENV !== 'production') {
      if (typeof window.history === 'undefined') {
        console.error(`Warning: window.history is not available.`)
        return
      }

      if (typeof window.history[method] === 'undefined') {
        console.error(`Warning: window.history.${method} is not available`)
        return
      }
    }

    if (method !== 'pushState' || getURL() !== as) {
      this._shallow = options.shallow
      window.history[method](
        {
          url,
          as,
          options,
          __N: true,
          key: (this._key = method !== 'pushState' ? this._key : createKey()),
        } as HistoryState,
        // Most browsers currently ignores this parameter, although they may use it in the future.
        // Passing the empty string here should be safe against future changes to the method.
        // https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
        '',
        as
      )
    }
  }

  async handleRouteInfoError(
    err: Error & { code?: any; cancelled?: boolean },
    pathname: string,
    query: ParsedUrlQuery,
    as: string,
    routeProps: RouteProperties,
    loadErrorFail?: boolean
  ): Promise<CompletePrivateRouteInfo> {
    console.error(err)

    if (err.cancelled) {
      // bubble up cancellation errors
      throw err
    }

    if (isAssetError(err) || loadErrorFail) {
      Router.events.emit('routeChangeError', err, as, routeProps)

      // If we can't load the page it could be one of following reasons
      //  1. Page doesn't exists
      //  2. Page does exist in a different zone
      //  3. Internal error while loading the page

      // So, doing a hard reload is the proper way to deal with this.
      handleHardNavigation({
        url: as,
        router: this,
      })

      // Changing the URL doesn't block executing the current code path.
      // So let's throw a cancellation error stop the routing logic.
      throw buildCancellationError()
    }

    try {
      let props: Record<string, any> | undefined
      const { page: Component, styleSheets } = await this.fetchComponent(
        '/_error'
      )

      const routeInfo: CompletePrivateRouteInfo = {
        props,
        Component,
        styleSheets,
        err,
        error: err,
      }

      if (!routeInfo.props) {
        try {
          routeInfo.props = await this.getInitialProps(Component, {
            err,
            pathname,
            query,
          } as any)
        } catch (gipErr) {
          console.error('Error in error page `getInitialProps`: ', gipErr)
          routeInfo.props = {}
        }
      }

      return routeInfo
    } catch (routeInfoErr) {
      return this.handleRouteInfoError(
        isError(routeInfoErr) ? routeInfoErr : new Error(routeInfoErr + ''),
        pathname,
        query,
        as,
        routeProps,
        true
      )
    }
  }

  async getRouteInfo({
    route: requestedRoute,
    pathname,
    query,
    as,
    resolvedAs,
    routeProps,
    locale,
    hasMiddleware,
    isPreview,
    unstable_skipClientCache,
  }: {
    route: string
    pathname: string
    query: ParsedUrlQuery
    as: string
    resolvedAs: string
    hasMiddleware?: boolean
    routeProps: RouteProperties
    locale: string | undefined
    isPreview: boolean
    unstable_skipClientCache?: boolean
  }) {
    /**
     * This `route` binding can change if there's a rewrite
     * so we keep a reference to the original requested route
     * so we can store the cache for it and avoid re-requesting every time
     * for shallow routing purposes.
     */
    let route = requestedRoute

    try {
      const handleCancelled = getCancelledHandler({ route, router: this })

      let existingInfo: PrivateRouteInfo | undefined = this.components[route]
      if (routeProps.shallow && existingInfo && this.route === route) {
        return existingInfo
      }

      if (hasMiddleware) {
        existingInfo = undefined
      }

      let cachedRouteInfo =
        existingInfo &&
        !('initial' in existingInfo) &&
        process.env.NODE_ENV !== 'development'
          ? existingInfo
          : undefined

      const fetchNextDataParams: FetchNextDataParams = {
        dataHref: this.pageLoader.getDataHref({
          href: formatWithValidation({ pathname, query }),
          skipInterpolation: true,
          asPath: resolvedAs,
          locale,
        }),
        hasMiddleware: true,
        isServerRender: this.isSsr,
        parseJSON: true,
        inflightCache: this.sdc,
        persistCache: !isPreview,
        isPrefetch: false,
        unstable_skipClientCache,
      }

      const data = await withMiddlewareEffects({
        fetchData: () => fetchNextData(fetchNextDataParams),
        asPath: resolvedAs,
        locale: locale,
        router: this,
      })
      handleCancelled()

      if (
        data?.effect?.type === 'redirect-internal' ||
        data?.effect?.type === 'redirect-external'
      ) {
        return data.effect
      }

      if (data?.effect?.type === 'rewrite') {
        route = removeTrailingSlash(data.effect.resolvedHref)
        pathname = data.effect.resolvedHref
        query = { ...query, ...data.effect.parsedAs.query }
        resolvedAs = removeBasePath(
          normalizeLocalePath(data.effect.parsedAs.pathname, this.locales)
            .pathname
        )

        // Check again the cache with the new destination.
        existingInfo = this.components[route]
        if (
          routeProps.shallow &&
          existingInfo &&
          this.route === route &&
          !hasMiddleware
        ) {
          // If we have a match with the current route due to rewrite,
          // we can copy the existing information to the rewritten one.
          // Then, we return the information along with the matched route.
          return { ...existingInfo, route }
        }
      }

      if (route === '/api' || route.startsWith('/api/')) {
        handleHardNavigation({ url: as, router: this })
        return new Promise<never>(() => {})
      }

      const routeInfo =
        cachedRouteInfo ||
        (await this.fetchComponent(route).then<CompletePrivateRouteInfo>(
          (res) => ({
            Component: res.page,
            styleSheets: res.styleSheets,
            __N_SSG: res.mod.__N_SSG,
            __N_SSP: res.mod.__N_SSP,
            __N_RSC: !!res.mod.__next_rsc__,
          })
        ))

      if (process.env.NODE_ENV !== 'production') {
        const { isValidElementType } = require('next/dist/compiled/react-is')
        if (!isValidElementType(routeInfo.Component)) {
          throw new Error(
            `The default export is not a React Component in page: "${pathname}"`
          )
        }
      }

      /**
       * For server components, non-SSR pages will have statically optimized
       * flight data in a production build. So only development and SSR pages
       * will always have the real-time generated and streamed flight data.
       */
      const useStreamedFlightData =
        routeInfo.__N_RSC &&
        (process.env.NODE_ENV !== 'production' || routeInfo.__N_SSP)

      const shouldFetchData =
        routeInfo.__N_SSG || routeInfo.__N_SSP || routeInfo.__N_RSC

      const { props } = await this._getData(async () => {
        if (shouldFetchData && !useStreamedFlightData) {
          const { json } = data?.json
            ? data
            : await fetchNextData({
                dataHref: this.pageLoader.getDataHref({
                  href: formatWithValidation({ pathname, query }),
                  asPath: resolvedAs,
                  locale,
                }),
                isServerRender: this.isSsr,
                parseJSON: true,
                inflightCache: this.sdc,
                persistCache: !isPreview,
                isPrefetch: false,
                unstable_skipClientCache,
              })

          return {
            props: json || {},
          }
        }

        return {
          headers: {},
          props: await this.getInitialProps(
            routeInfo.Component,
            // we provide AppTree later so this needs to be `any`
            {
              pathname,
              query,
              asPath: as,
              locale,
              locales: this.locales,
              defaultLocale: this.defaultLocale,
            } as any
          ),
        }
      })

      // Only bust the data cache for SSP routes although
      // middleware can skip cache per request with
      // x-middleware-cache: no-cache as well
      if (routeInfo.__N_SSP && fetchNextDataParams.dataHref) {
        const cacheKey = new URL(
          fetchNextDataParams.dataHref,
          window.location.href
        ).href
        delete this.sdc[cacheKey]
      }

      // we kick off a HEAD request in the background
      // when a non-prefetch request is made to signal revalidation
      if (
        !this.isPreview &&
        routeInfo.__N_SSG &&
        process.env.NODE_ENV !== 'development'
      ) {
        fetchNextData(
          Object.assign({}, fetchNextDataParams, {
            isBackground: true,
            persistCache: false,
            inflightCache: backgroundCache,
          })
        ).catch(() => {})
      }

      let flightInfo
      if (routeInfo.__N_RSC) {
        flightInfo = {
          __flight__: useStreamedFlightData
            ? (
                await this._getData(() =>
                  this._getFlightData(
                    formatWithValidation({
                      query: { ...query, __flight__: '1' },
                      pathname: isDynamicRoute(route)
                        ? interpolateAs(
                            pathname,
                            parseRelativeUrl(resolvedAs).pathname,
                            query
                          ).result
                        : pathname,
                    })
                  )
                )
              ).data
            : props.__flight__,
        }
      }

      props.pageProps = Object.assign({}, props.pageProps, flightInfo)
      routeInfo.props = props
      routeInfo.route = route
      routeInfo.query = query
      routeInfo.resolvedAs = resolvedAs
      this.components[route] = routeInfo

      return routeInfo
    } catch (err) {
      return this.handleRouteInfoError(
        getProperError(err),
        pathname,
        query,
        as,
        routeProps
      )
    }
  }

  private set(
    state: typeof this.state,
    data: PrivateRouteInfo,
    resetScroll: { x: number; y: number } | null
  ): Promise<void> {
    this.state = state

    return this.sub(
      data,
      this.components['/_app'].Component as AppComponent,
      resetScroll
    )
  }

  /**
   * Callback to execute before replacing router state
   * @param cb callback to be executed
   */
  beforePopState(cb: BeforePopStateCallback) {
    this._bps = cb
  }

  onlyAHashChange(as: string): boolean {
    if (!this.asPath) return false
    const [oldUrlNoHash, oldHash] = this.asPath.split('#')
    const [newUrlNoHash, newHash] = as.split('#')

    // Makes sure we scroll to the provided hash if the url/hash are the same
    if (newHash && oldUrlNoHash === newUrlNoHash && oldHash === newHash) {
      return true
    }

    // If the urls are change, there's more than a hash change
    if (oldUrlNoHash !== newUrlNoHash) {
      return false
    }

    // If the hash has changed, then it's a hash only change.
    // This check is necessary to handle both the enter and
    // leave hash === '' cases. The identity case falls through
    // and is treated as a next reload.
    return oldHash !== newHash
  }

  scrollToHash(as: string): void {
    const [, hash = ''] = as.split('#')
    // Scroll to top if the hash is just `#` with no value or `#top`
    // To mirror browsers
    if (hash === '' || hash === 'top') {
      window.scrollTo(0, 0)
      return
    }

    // Decode hash to make non-latin anchor works.
    const rawHash = decodeURIComponent(hash)
    // First we check if the element by id is found
    const idEl = document.getElementById(rawHash)
    if (idEl) {
      idEl.scrollIntoView()
      return
    }
    // If there's no element with the id, we check the `name` property
    // To mirror browsers
    const nameEl = document.getElementsByName(rawHash)[0]
    if (nameEl) {
      nameEl.scrollIntoView()
    }
  }

  urlIsNew(asPath: string): boolean {
    return this.asPath !== asPath
  }

  /**
   * Prefetch page code, you may wait for the data during page rendering.
   * This feature only works in production!
   * @param url the href of prefetched page
   * @param asPath the as path of the prefetched page
   */
  async prefetch(
    url: string,
    asPath: string = url,
    options: PrefetchOptions = {}
  ): Promise<void> {
    let parsed = parseRelativeUrl(url)

    let { pathname, query } = parsed

    if (process.env.__NEXT_I18N_SUPPORT) {
      if (options.locale === false) {
        pathname = normalizeLocalePath!(pathname, this.locales).pathname
        parsed.pathname = pathname
        url = formatWithValidation(parsed)

        let parsedAs = parseRelativeUrl(asPath)
        const localePathResult = normalizeLocalePath!(
          parsedAs.pathname,
          this.locales
        )
        parsedAs.pathname = localePathResult.pathname
        options.locale = localePathResult.detectedLocale || this.defaultLocale
        asPath = formatWithValidation(parsedAs)
      }
    }

    const pages = await this.pageLoader.getPageList()
    let resolvedAs = asPath

    const locale =
      typeof options.locale !== 'undefined'
        ? options.locale || undefined
        : this.locale

    if (process.env.__NEXT_HAS_REWRITES && asPath.startsWith('/')) {
      let rewrites: any
      ;({ __rewrites: rewrites } = await getClientBuildManifest())

      const rewritesResult = resolveRewrites(
        addBasePath(addLocale(asPath, this.locale), true),
        pages,
        rewrites,
        parsed.query,
        (p: string) => resolveDynamicRoute(p, pages),
        this.locales
      )

      if (rewritesResult.externalDest) {
        return
      }
      resolvedAs = removeLocale(
        removeBasePath(rewritesResult.asPath),
        this.locale
      )

      if (rewritesResult.matchedPage && rewritesResult.resolvedHref) {
        // if this directly matches a page we need to update the href to
        // allow the correct page chunk to be loaded
        pathname = rewritesResult.resolvedHref
        parsed.pathname = pathname

        url = formatWithValidation(parsed)
      }
    }
    parsed.pathname = resolveDynamicRoute(parsed.pathname, pages)

    if (isDynamicRoute(parsed.pathname)) {
      pathname = parsed.pathname
      parsed.pathname = pathname
      Object.assign(
        query,
        getRouteMatcher(getRouteRegex(parsed.pathname))(
          parsePath(asPath).pathname
        ) || {}
      )

      url = formatWithValidation(parsed)
    }

    // Prefetch is not supported in development mode because it would trigger on-demand-entries
    if (process.env.NODE_ENV !== 'production') {
      return
    }

    const route = removeTrailingSlash(pathname)

    await Promise.all([
      this.pageLoader._isSsg(route).then((isSsg) => {
        return isSsg
          ? fetchNextData({
              dataHref: this.pageLoader.getDataHref({
                href: url,
                asPath: resolvedAs,
                locale: locale,
              }),
              isServerRender: false,
              parseJSON: true,
              inflightCache: this.sdc,
              persistCache: !this.isPreview,
              isPrefetch: true,
              unstable_skipClientCache:
                options.unstable_skipClientCache ||
                (options.priority &&
                  !!process.env.__NEXT_OPTIMISTIC_CLIENT_CACHE),
            }).then(() => false)
          : false
      }),
      this.pageLoader[options.priority ? 'loadPage' : 'prefetch'](route),
    ])
  }

  async fetchComponent(route: string) {
    const handleCancelled = getCancelledHandler({ route, router: this })

    try {
      const componentResult = await this.pageLoader.loadPage(route)
      handleCancelled()

      return componentResult
    } catch (err) {
      handleCancelled()
      throw err
    }
  }

  _getData<T>(fn: () => Promise<T>): Promise<T> {
    let cancelled = false
    const cancel = () => {
      cancelled = true
    }
    this.clc = cancel
    return fn().then((data) => {
      if (cancel === this.clc) {
        this.clc = null
      }

      if (cancelled) {
        const err: any = new Error('Loading initial props cancelled')
        err.cancelled = true
        throw err
      }

      return data
    })
  }

  _getFlightData(dataHref: string) {
    // Do not cache RSC flight response since it's not a static resource
    return fetchNextData({
      dataHref,
      isServerRender: true,
      parseJSON: false,
      inflightCache: this.sdc,
      persistCache: false,
      isPrefetch: false,
    }).then(({ text }) => ({ data: text }))
  }

  getInitialProps(
    Component: ComponentType,
    ctx: NextPageContext
  ): Promise<any> {
    const { Component: App } = this.components['/_app']
    const AppTree = this._wrapApp(App as AppComponent)
    ctx.AppTree = AppTree
    return loadGetInitialProps<AppContextType<Router>>(App, {
      AppTree,
      Component,
      router: this,
      ctx,
    })
  }

  get route(): string {
    return this.state.route
  }

  get pathname(): string {
    return this.state.pathname
  }

  get query(): ParsedUrlQuery {
    return this.state.query
  }

  get asPath(): string {
    return this.state.asPath
  }

  get locale(): string | undefined {
    return this.state.locale
  }

  get isFallback(): boolean {
    return this.state.isFallback
  }

  get isPreview(): boolean {
    return this.state.isPreview
  }
}
