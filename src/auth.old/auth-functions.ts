import { PrismaClient, User, Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import sha256 from "crypto-js/sha256";
import Base64 from "crypto-js/enc-base64";
import cryptoRandomString from "crypto-random-string";
import { Api400Error } from "../error-handling/api-errors.old";
import { BaseError } from "../utils/ApiError";
import {
  issueNewToken,
  verifyAccessTokenAndGetUserUuid,
} from "./utils/generate-and-verifyToken";

import {
  generateAccessToken,
  generateRefreshToken,
} from "./utils/generate-and-verifyToken";
import { blockAccessToken } from "./utils/access-token-blocklist";
import { LogoutInterface } from "../interfaces/AuthInterfaces";
import { UUID } from "../types/uuid-class";
import { sendPasswordResetMail } from "../services/mail-service";
import prisma from "../init-prisma-client";

export async function signup(email: string, password: string) {
  //Has password and create user

  let user: User;
  try {
    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      timeCost: 2,
      memoryCost: 15360,
    });
    user = await prisma.user.create({
      data: { email, password: hashedPassword },
    });
  } catch (err: any) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return new Api400Error({
        name: "EmailAlreadyUsed",
        message:
          // "The e-mail adress is already being used. Please choose another e-mail address.",
          "A link to activate your account has been emailed to the address provided.",
      });
    } else {
      return new Api400Error({
        name: err.name,
        message: err.message,
      });
    }
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();

  //store the refresh token in the database - this for now restricts the no. of refresh token to one
  await prisma.user.update({
    where: { uuid: user.uuid },
    data: {
      refreshToken: Base64.stringify(sha256(refreshToken)),
      //One refresh token is valid for 7 days, but within 30 days (loginExpiry) a new refresh token will be issued if the user has a valid refresh token
      refreshTokenExpiry: Math.floor(Date.now() / 1000) + 604800,
      loginExpiry: Math.floor(Date.now() / 1000) + 2592000,
    },
  });

  return {
    accessToken,
    refreshToken,
    user,
  };
}

export async function login(email: string, plainPassword: string) {
  // Find user in database
  const user = await prisma.user.findUnique({
    where: { email: email },
  });
  if (!user) {
    return new BaseError({
      name: "InvalidCredentials",
      message: "Your e-mail and password combination is invalid.",
    });
  }

  const passwordIsvalid = await argon2.verify(user.password, plainPassword);
  if (passwordIsvalid) {
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();

    //store the refresh token in the database - this for now restricts the no. of refresh token to one
    await prisma.user.update({
      where: { uuid: user.uuid },
      data: {
        refreshToken: Base64.stringify(sha256(refreshToken)),
        //One refresh token is valid for 7 days, but within 30 days (loginExpiry) a new refresh token will be issued if the user has a valid refresh token
        refreshTokenExpiry: Math.floor(Date.now() / 1000) + 604800,
        loginExpiry: Math.floor(Date.now() / 1000) + 2592000,
      },
    });

    return {
      accessToken,
      refreshToken,
      user,
    };
  } else {
    return new BaseError({
      name: "InvalidCredentials",
      message: "Your e-mail and password combination is invalid.",
    });
  }
}

export async function logout(logoutData: LogoutInterface) {
  let userUuid: string | undefined = undefined;

  if (logoutData.user) {
    userUuid = logoutData.user.uuid;
  }
  if (logoutData.accessToken) {
    //Handle Access Token: add to blocklist if it's valid
    try {
      userUuid = verifyAccessTokenAndGetUserUuid(
        logoutData.accessToken
      ).toString();
      blockAccessToken(logoutData.accessToken);
    } catch {
      //No need to logout if access token is already invalid
    }
  }
  resetLogin(userUuid);
  //TODO: This is kinda redundant. If we receive an user as well as an refresh token, both should refer to the same user
  //But there may be some edge cases, were we want to be sure that the refresh token is definitely revoked
  if (logoutData.refreshToken) {
    const user = await prisma.user.findFirst({
      where: {
        refreshToken: Base64.stringify(sha256(logoutData.refreshToken)),
      },
    });
    userUuid = user?.uuid;
    resetLogin(userUuid);
  }
}

function resetLogin(userUuid: string | undefined) {
  if (userUuid) {
    prisma.user.update({
      where: {
        uuid: userUuid,
      },
      data: {
        refreshToken: null,
        refreshTokenExpiry: null,
        loginExpiry: null,
      },
    });
  }
}

export async function updateEmail(email: string, userUuid: UUID) {
  //TODO: verify that e-mail is valid and lowercase, check authentication
  try {
    const updatedUser = await prisma.user.update({
      where: { uuid: userUuid.toString() },
      data: {
        email: email,
      },
    });
    return updatedUser.email;
  } catch (err: any) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return new Api400Error({
        name: "EmailAlreadyUsed",
        message:
          "The e-mail adress is already being used. Please choose another e-mail address.",
      });
    } else {
      return new Api400Error({
        name: err.name,
        message: err.message,
      });
    }
  }
}

export async function changePasswordWhenLoggedIn(
  //TODO: verify password, check authentication
  oldPassword: string,
  newPassword: string,
  userUuid: UUID
) {
  const user = await prisma.user.findUnique({
    where: { uuid: userUuid.toString() },
  });
  if (user) {
    const oldPasswordIsValid = await argon2.verify(user.password, oldPassword);
    if (oldPasswordIsValid) {
      const hashedPassword = await argon2.hash(newPassword, {
        type: argon2.argon2id,
        timeCost: 2,
        memoryCost: 15360,
      });

      const updatedUser = await prisma.user.update({
        where: { uuid: userUuid.toString() },
        data: {
          password: hashedPassword,
        },
      });

      await logout({ user: user });
      return true;
    } else {
      return new BaseError({
        name: "InvalidCredentials",
        message: "Your e-mail and password combination is invalid.",
      });
    }
  } else {
    return new BaseError({
      name: "InvalidCredentials",
      message: "Your e-mail and password combination is invalid.",
    });
  }
}

export async function requestPasswordResetMail(email: string) {
  const user = await prisma.user.findUnique({
    where: {
      email: email,
    },
  });
  if (user) {
    const resetCode = cryptoRandomString(100);
    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        //TODO: is encryption needed?
        passwordResetCode: resetCode,
        passwordResetExpiry: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    const mailResult = await sendPasswordResetMail(resetCode, user.email);
  } else {
    return new Api400Error({
      name: "InvaldidEmail",
      message: "The e-mail adress is not in the database.",
    });
  }
}

export async function resetPasswordWithCode(
  //TODO: verify password
  newPassword: string,
  resetCode: string
) {
  const user = await prisma.user.findFirst({
    where: {
      passwordResetCode: resetCode,
    },
  });
  if (user) {
    const resetCodeIsNotExpired =
      user.passwordResetExpiry! > Math.floor(Date.now() / 1000);

    if (resetCodeIsNotExpired) {
      const hashedPassword = await argon2.hash(newPassword, {
        type: argon2.argon2id,
        timeCost: 2,
        memoryCost: 15360,
      });

      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          password: hashedPassword,
          passwordResetCode: null,
          passwordResetExpiry: null,
        },
      });

      logout({ user: user });
    } else {
      throw new BaseError({
        name: "ExpiredResetLink",
        message:
          "Your password reset link is expired. Please request a new one.",
      });
    }
  } else {
    throw new BaseError({
      name: "InvalidResetLink",
      message: "Your password reset link is invalid. Please request a new one.",
    });
  }
}

export async function refreshAndStoreNewToken(refreshToken: string) {
  const refreshReturn = await issueNewToken(refreshToken, prisma);

  if (refreshReturn instanceof Error) {
    return new BaseError({
      name: refreshReturn.name,
      message: refreshReturn.message,
    });
  }

  const { newAccessToken, newRefreshToken, user } = refreshReturn;

  // Update token but keep expiry date
  await prisma.user.update({
    where: { uuid: user.uuid },
    data: {
      refreshToken: Base64.stringify(sha256(refreshToken)),
      // We don't update the loginExpiry, the user MUST login every 30 days
      refreshTokenExpiry: Math.floor(Date.now() / 1000) + 604800,
    },
  });

  return { newAccessToken, newRefreshToken, user };
}