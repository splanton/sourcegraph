import { HoveredToken, LOADER_DELAY } from '@sourcegraph/codeintellify'
import * as H from 'history'
import { isEqual, uniqWith } from 'lodash'
import { combineLatest, merge, Observable, of, Subscription, Unsubscribable } from 'rxjs'
import {
    catchError,
    delay,
    distinctUntilChanged,
    filter,
    first,
    map,
    share,
    startWith,
    switchMap,
    takeUntil,
} from 'rxjs/operators'
import { ActionItemProps } from '../actions/ActionItem'
import { Context } from '../api/client/context/context'
import { Model } from '../api/client/model'
import { Services } from '../api/client/services'
import { ContributableMenu, TextDocumentPositionParams } from '../api/protocol'
import { getContributedActionItems } from '../contributions/contributions'
import { ExtensionsControllerProps } from '../extensions/controller'
import { PlatformContext, PlatformContextProps } from '../platform/context'
import { asError, ErrorLike, isErrorLike } from '../util/errors'
import { makeRepoURI, parseRepoURI, withWorkspaceRootInputRevision } from '../util/url'
import { HoverContext } from './HoverOverlay'

const LOADING: 'loading' = 'loading'

/**
 * This function is passed to {@link module:@sourcegraph/codeintellify.createHoverifier}, which uses it to fetch
 * the list of buttons to display on the hover tooltip. This function in turn determines that by looking at all
 * action contributions for the "hover" menu. It also defines two builtin hover actions: "Go to definition" and
 * "Find references".
 */
export function getHoverActions(
    { extensionsController, platformContext }: ExtensionsControllerProps & PlatformContextProps<'urlToFile'>,
    hoverContext: HoveredToken & HoverContext
): Observable<ActionItemProps[]> {
    return getHoverActionsContext({ extensionsController, platformContext }, hoverContext).pipe(
        switchMap(context =>
            extensionsController.services.contribution
                .getContributions(undefined, context)
                .pipe(map(contributions => getContributedActionItems(contributions, ContributableMenu.Hover)))
        )
    )
}

/**
 * The scoped context properties for the hover.
 *
 * @internal Exported for testing only.
 */
export interface HoverActionsContext extends Context<TextDocumentPositionParams> {
    ['goToDefinition.showLoading']: boolean
    ['goToDefinition.url']: string | null
    ['goToDefinition.notFound']: boolean
    ['goToDefinition.error']: boolean
    ['findReferences.url']: string | null
    hoverPosition: TextDocumentPositionParams
}

/**
 * Returns an observable that emits the scoped context for the hover upon subscription and whenever it changes.
 *
 * @internal Exported for testing only.
 */
export function getHoverActionsContext(
    {
        extensionsController,
        platformContext: { urlToFile },
    }:
        | (ExtensionsControllerProps & PlatformContextProps<'urlToFile'>)
        | {
              extensionsController: {
                  services: {
                      model: {
                          model: { value: Pick<Model, 'roots'> }
                      }
                      textDocumentDefinition: Pick<Services['textDocumentDefinition'], 'getLocations'>
                      textDocumentReferences: Pick<Services['textDocumentReferences'], 'providersForDocument'>
                  }
              }
              platformContext: Pick<PlatformContext, 'urlToFile'>
          },
    hoverContext: HoveredToken & HoverContext
): Observable<Context<TextDocumentPositionParams>> {
    const params: TextDocumentPositionParams = {
        textDocument: { uri: makeRepoURI(hoverContext) },
        position: { line: hoverContext.line - 1, character: hoverContext.character - 1 },
    }
    const definitionURLOrError = getDefinitionURL({ urlToFile }, extensionsController.services, params).pipe(
        map(result => (result ? result.url : result)), // we only care about the URL or null, not whether there are multiple
        catchError(err => [asError(err) as ErrorLike]),
        share()
    )

    return combineLatest(
        // To reduce UI jitter, don't show "Go to definition" until (1) the result or an error was received or (2)
        // the fairly long LOADER_DELAY has elapsed.
        merge(
            [undefined], // don't block on the first emission
            of(LOADING).pipe(
                delay(LOADER_DELAY),
                takeUntil(definitionURLOrError)
            ),
            definitionURLOrError
        ),

        // Only show "Find references" if a reference provider is registered. Unlike definitions, references are
        // not preloaded and here just involve statically constructing a URL, so no need to indicate loading.
        extensionsController.services.textDocumentReferences
            .providersForDocument(params.textDocument)
            .pipe(map(providers => providers.length !== 0)),

        // If there is no definition, delay showing "Find references" because it is likely that the token is
        // punctuation or something else that has no meaningful references. This reduces UI jitter when it can be
        // quickly determined that there is no definition. TODO(sqs): Allow reference providers to register
        // "trigger characters" or have a "hasReferences" method to opt-out of being called for certain tokens.
        merge(
            of(true).pipe(
                delay(LOADER_DELAY),
                takeUntil(definitionURLOrError.pipe(filter(v => !!v)))
            ),
            definitionURLOrError.pipe(
                filter(v => !!v),
                map(v => !!v)
            )
        ).pipe(startWith(false))
    ).pipe(
        map(
            ([definitionURLOrError, hasReferenceProvider, showFindReferences]): HoverActionsContext => ({
                'goToDefinition.showLoading': definitionURLOrError === LOADING,
                'goToDefinition.url':
                    (definitionURLOrError !== LOADING && !isErrorLike(definitionURLOrError) && definitionURLOrError) ||
                    null,
                'goToDefinition.notFound':
                    definitionURLOrError !== LOADING &&
                    !isErrorLike(definitionURLOrError) &&
                    definitionURLOrError === null,
                'goToDefinition.error':
                    isErrorLike(definitionURLOrError) && ((definitionURLOrError as any).stack as any),

                'findReferences.url':
                    hasReferenceProvider && showFindReferences
                        ? urlToFile({ ...hoverContext, position: hoverContext, viewState: 'references' })
                        : null,

                // Store hoverPosition for the goToDefinition action's commandArguments to refer to.
                hoverPosition: params,
            })
        ),
        distinctUntilChanged((a, b) => isEqual(a, b))
    )
}

/**
 * Returns an observable that emits null if no definitions are found, {url, multiple: false} if exactly 1
 * definition is found, {url: defPanelURL, multiple: true} if multiple definitions are found, or an error.
 *
 * @internal Exported for testing only.
 */
export function getDefinitionURL(
    { urlToFile }: Pick<PlatformContext, 'urlToFile'>,
    {
        model,
        textDocumentDefinition,
    }: {
        model: {
            model: { value: Pick<Model, 'roots'> }
        }
        textDocumentDefinition: Pick<Services['textDocumentDefinition'], 'getLocations'>
    },
    params: TextDocumentPositionParams
): Observable<{ url: string; multiple: boolean } | null> {
    return textDocumentDefinition.getLocations(params).pipe(
        switchMap(locations => locations),
        map(definitions => {
            if (definitions === null || definitions.length === 0) {
                return null
            }

            // Get unique definitions.
            definitions = uniqWith(definitions, isEqual)

            if (definitions.length > 1) {
                // Open the panel to show all definitions.
                const uri = withWorkspaceRootInputRevision(
                    model.model.value.roots || [],
                    parseRepoURI(params.textDocument.uri)
                )
                return {
                    url: urlToFile({
                        ...uri,
                        rev: uri.rev || '',
                        filePath: uri.filePath || '',
                        position: { line: params.position.line + 1, character: params.position.character + 1 },
                        viewState: 'def',
                    }),
                    multiple: true,
                }
            }
            const def = definitions[0]

            // Preserve the input revision (e.g., a Git branch name instead of a Git commit SHA) if the result is
            // inside one of the current roots. This avoids navigating the user from (e.g.) a URL with a nice Git
            // branch name to a URL with a full Git commit SHA.
            const uri = withWorkspaceRootInputRevision(model.model.value.roots || [], parseRepoURI(def.uri))

            if (def.range) {
                uri.position = {
                    line: def.range.start.line + 1,
                    character: def.range.start.character + 1,
                }
            }

            return {
                url: urlToFile({
                    ...uri,
                    rev: uri.rev || '',
                    filePath: uri.filePath || '',
                }),
                multiple: false,
            }
        })
    )
}

/**
 * Registers contributions for hover-related functionality.
 */
export function registerHoverContributions({
    extensionsController,
    platformContext: { urlToFile },
    history,
}: (
    | (ExtensionsControllerProps & PlatformContextProps)
    | {
          extensionsController: {
              services: Pick<Services, 'commands' | 'contribution'> & {
                  model: {
                      model: { value: Pick<Model, 'roots'> }
                  }
                  textDocumentDefinition: Pick<Services['textDocumentDefinition'], 'getLocations'>
              }
          }
          platformContext: Pick<PlatformContext, 'urlToFile'>
      }) & {
    history: H.History
}): Unsubscribable {
    const subscriptions = new Subscription()

    // Registers the "Go to definition" action shown in the hover tooltip. When clicked, the action finds the
    // definition of the token using the registered definition providers and navigates the user there.
    //
    // When the user hovers over a token (even before they click "Go to definition"), it attempts to preload the
    // definition. If preloading succeeds and at least 1 definition is found, the "Go to definition" action becomes
    // a normal link (<a href>) pointing to the definition's URL. Using a normal link here is good for a11y and UX
    // (e.g., open-in-new-tab works and the browser status bar shows the URL).
    //
    // Otherwise (if preloading fails, or if preloading has not yet finished), clicking "Go to definition" executes
    // the goToDefinition command. A loading indicator is displayed, and any errors that occur during execution are
    // shown to the user.
    //
    // Future improvements:
    //
    // TODO(sqs): If the user middle-clicked or Cmd/Ctrl-clicked the button, it would be nice if when the
    // definition was found, a new browser tab was opened to the destination. This is not easy because browsers
    // usually block new tabs opened by JavaScript not directly triggered by a user mouse/keyboard interaction.
    //
    // TODO(sqs): Pin hover after an action has been clicked and before it has completed.
    subscriptions.add(
        extensionsController.services.contribution.registerContributions({
            contributions: {
                actions: [
                    {
                        id: 'goToDefinition',
                        title: 'Go to definition',
                        command: 'goToDefinition',
                        commandArguments: [
                            // tslint:disable:no-invalid-template-strings
                            '${json(hoverPosition)}',
                            // tslint:enable:no-invalid-template-strings
                        ],
                    },
                    {
                        // This action is used when preloading the definition succeeded and at least 1
                        // definition was found.
                        id: 'goToDefinition.preloaded',
                        title: 'Go to definition',
                        command: 'open',
                        // tslint:disable-next-line:no-invalid-template-strings
                        commandArguments: ['${goToDefinition.url}'],
                    },
                ],
                menus: {
                    hover: [
                        // Do not show any actions if no definition provider is registered. (In that case,
                        // goToDefinition.{error, loading, url} will all be falsey.)
                        {
                            action: 'goToDefinition',
                            when: 'goToDefinition.error || goToDefinition.showLoading',
                        },
                        {
                            action: 'goToDefinition.preloaded',
                            when: 'goToDefinition.url',
                        },
                    ],
                },
            },
        })
    )
    subscriptions.add(
        extensionsController.services.commands.registerCommand({
            command: 'goToDefinition',
            run: async (paramsStr: string) => {
                const params: TextDocumentPositionParams = JSON.parse(paramsStr)
                const result = await getDefinitionURL({ urlToFile }, extensionsController.services, params)
                    .pipe(first())
                    .toPromise()
                if (!result) {
                    throw new Error('No definition found.')
                }
                if (result.url === H.createPath(history.location)) {
                    // The user might be confused if they click "Go to definition" and don't go anywhere, which
                    // occurs if they are *already* on the definition. Give a helpful tip if they do this.
                    //
                    // Note that these tips won't show up if the definition URL is already known by the time they
                    // click "Go to definition", because then it's a normal link and not a button that executes
                    // this command. TODO: It would be nice if they also showed up in that case.
                    if (result.multiple) {
                        // The user may not have noticed the panel at the bottom of the screen, so tell them
                        // explicitly.
                        throw new Error('Multiple definitions shown in panel below.')
                    }
                    throw new Error('Already at the definition.')
                }
                history.push(result.url)
            },
        })
    )

    // Register the "Find references" action shown in the hover tooltip. This is simpler than "Go to definition"
    // because it just needs a URL that can be statically constructed from the current URL (it does not need to
    // query any providers).
    subscriptions.add(
        extensionsController.services.contribution.registerContributions({
            contributions: {
                actions: [
                    {
                        id: 'findReferences',
                        title: 'Find references',
                        command: 'open',
                        // tslint:disable-next-line:no-invalid-template-strings
                        commandArguments: ['${findReferences.url}'],
                    },
                ],
                menus: {
                    hover: [
                        // To reduce UI jitter, even though "Find references" can be shown immediately (because
                        // the URL can be statically constructed), don't show it until either (1) "Go to
                        // definition" is showing or (2) the LOADER_DELAY has elapsed. The part (2) of this
                        // logic is implemented in the observable pipe that sets findReferences.url above.
                        {
                            action: 'findReferences',
                            when:
                                'findReferences.url && (goToDefinition.showLoading || goToDefinition.url || goToDefinition.error || goToDefinition.notFound)',
                        },
                    ],
                },
            },
        })
    )

    return subscriptions
}
