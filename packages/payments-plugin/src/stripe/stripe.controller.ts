import { Controller, Headers, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
    ChannelService,
    InternalServerError,
    LanguageCode,
    Logger,
    Order,
    OrderService,
    PaymentMethod,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { OrderStateTransitionError } from '@vendure/core/dist/common/error/generated-graphql-shop-errors';
import { Response } from 'express';
import Stripe from 'stripe';

import { loggerCtx } from './constants';
import { stripePaymentMethodHandler } from './stripe.handler';
import { StripeService } from './stripe.service';
import { IncomingMessageWithRawBody } from './types';

const missingHeaderErrorMessage = 'Missing stripe-signature header';
const signatureErrorMessage = 'Error verifying Stripe webhook signature';
const noPaymentIntentErrorMessage = 'No payment intent in the event payload';

@Controller('payments')
export class StripeController {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private orderService: OrderService,
        private stripeService: StripeService,
    ) {}

    @Post('stripe')
    async webhook(
        @Headers('stripe-signature') signature: string | undefined,
        @Req() request: IncomingMessageWithRawBody,
        @Res() response: Response,
    ): Promise<void> {
        if (!signature) {
            Logger.error(missingHeaderErrorMessage, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(missingHeaderErrorMessage);
            return;
        }

        let event = null;
        try {
            event = this.stripeService.constructEventFromPayload(request.rawBody, signature);
        } catch (e: any) {
            Logger.error(`${signatureErrorMessage} ${signature}: ${e.message}`, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(signatureErrorMessage);
            return;
        }

        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        if (!paymentIntent) {
            Logger.error(noPaymentIntentErrorMessage, loggerCtx);
            response.status(HttpStatus.BAD_REQUEST).send(noPaymentIntentErrorMessage);
            return;
        }

        const { metadata: { channelToken, orderCode, orderId } = {} } = paymentIntent;

        if (event.type === 'payment_intent.payment_failed') {
            const message = paymentIntent.last_payment_error?.message;
            Logger.warn(`Payment for order ${orderCode} failed: ${message}`, loggerCtx);
            return;
        }

        if (event.type !== 'payment_intent.succeeded') {
            // This should never happen as the webhook is configured to receive
            // payment_intent.succeeded and payment_intent.payment_failed events only
            Logger.info(`Received ${event.type} status update for order ${orderCode}`, loggerCtx);
            return;
        }

        const ctx = await this.createContext(channelToken);

        const transitionToStateResult = await this.orderService.transitionToState(
            ctx,
            orderId,
            'ArrangingPayment',
        );

        if (transitionToStateResult instanceof OrderStateTransitionError) {
            Logger.error(
                `Error transitioning order ${orderCode} to ArrangingPayment state: ${transitionToStateResult.message}`,
                loggerCtx,
            );
            return;
        }

        const paymentMethod = await this.getPaymentMethod(ctx);

        const addPaymentToOrderResult = await this.orderService.addPaymentToOrder(ctx, orderId, {
            method: paymentMethod.code,
            metadata: {
                paymentIntentId: paymentIntent.id,
            },
        });

        if (!(addPaymentToOrderResult instanceof Order)) {
            Logger.error(
                `Error adding payment to order ${orderCode}: ${addPaymentToOrderResult.message}`,
                loggerCtx,
            );
            return;
        }

        Logger.info(`Stripe payment intent id ${paymentIntent.id} added to order ${orderCode}`, loggerCtx);
    }

    private async createContext(channelToken: string): Promise<RequestContext> {
        const channel = await this.channelService.getChannelFromToken(channelToken);

        return new RequestContext({
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            channel,
            languageCode: LanguageCode.en,
        });
    }

    private async getPaymentMethod(ctx: RequestContext): Promise<PaymentMethod> {
        const method = (await this.connection.getRepository(ctx, PaymentMethod).find()).find(
            m => m.handler.code === stripePaymentMethodHandler.code,
        );

        if (!method) {
            throw new InternalServerError(`[${loggerCtx}] Could not find Stripe PaymentMethod`);
        }

        return method;
    }
}